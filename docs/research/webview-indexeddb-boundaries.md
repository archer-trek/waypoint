# macOS WKWebView 与 Android WebView 的 IndexedDB 行为边界与最佳实践调研

用途：为 [Waypoint IndexedDB 持久化架构与草稿防抖决策地图 #127](https://github.com/archer-trek/waypoint/issues/127) 及 [perf(storage): split single-key IndexedDB session record and debounce draft persistence #124](https://github.com/archer-trek/waypoint/issues/124) 提供基于一手规范、引擎源码与实测机制的技术边界支撑。

运行环境：Waypoint 客户端基于 Tauri 2，macOS 采用系统 WKWebView，Android 采用系统 WebView（Chromium 内核，版本取决于设备当前选中的 WebView provider）；单元测试与集成测试运行于 Vitest + `fake-indexeddb`（Node.js / jsdom 环境）。

---

## 1. 长连接复用与后台回收（Connection Lifecycle & Abnormal Closures）

### 1.1 系统切后台与进程生命周期中的连接状态

在 Tauri 2 架构中，客户端进程与底层 WebView 引擎保持单实例映射：
- **macOS WKWebView**：采用多进程架构（UIProcess、WebProcess 与 NetworkProcess 分离）。当应用窗口隐藏、最小化或系统进入 App Nap 节能状态时，WebProcess 的 CPU 调度优先级会降低甚至被暂停，但只要进程未被杀死，内部建立的 `IDBDatabase` 连接句柄与 SQLite 连接并不会仅仅因时间空闲而被主动切断。
- **Android WebView**：在 Android 8.0+ 上默认启用多进程模式（Browser 宿主进程与 RenderProcess 沙盒隔离）。当 Activity 切入后台（`onPause` -> `onStop`）时，系统处于资源调度考虑可能暂停渲染管道，但 Chromium 底层的 LevelDB 数据库句柄保持打开，不会主动设置超时定时器关闭空闲连接。
- **异常关闭的真实根源**：连接被非预期断开不是因为应用处于空闲状态，而是源于底层进程或 I/O 异常：
  1. **WebKit 跨进程通道中断**：在 iOS/macOS 处于极度内存压力或休眠唤醒恢复时，若 NetworkProcess（负责底层 SQLite/IndexedDB 服务）崩溃或被系统终止，WebProcess 会在与服务通信失败时判定连接丢失。
  2. **Android 渲染进程回收（`onRenderProcessGone`）与 LMK**：当 Android 触发 Low Memory Killer 或 Chromium 内部遭遇致命 I/O 错误（如 LevelDB 文件锁损坏、底层文件损坏），Chromium 会向前端下发强制关闭通知。

### 1.2 `onclose` 事件的规范语义与误区

- **规范定义**：依据 [W3C IndexedDB 3.0 规范 Section 4.1.3](https://www.w3.org/TR/IndexedDB-3/#dom-idbdatabase-onclose) 与 [Section 4.1.5 Closing a database connection](https://www.w3.org/TR/IndexedDB-3/#closing-connection)：
  > *"A close event is fired on an IDBDatabase object when the connection was closed abnormally, such as if the backend crashed or the database file was deleted by an external process."*
  规范明确规定：**主动调用 `db.close()` 绝不会触发 `close` 事件**。只有在连接遭遇**异常终止（forced closure）**时，引擎才会向 `IDBDatabase` 派发 `close` 事件。
- **引擎源码佐证**：
  - **WebKit**（[`Source/WebCore/Modules/indexeddb/IDBDatabase.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/indexeddb/IDBDatabase.cpp)）：
    在 `IDBDatabase::close()` 中仅设置 `m_closePending = true` 并触发 `maybeCloseInServer()`，不派发 `closeEvent`；而当服务端断开调用 `IDBDatabase::connectionToServerLost(error)` 时，才将 `m_closedInServer = true`，终止全部在途事务，并显式派发 `errorEvent` 与 `closeEvent`。
  - **Chromium / Blink**（[`third_party/blink/renderer/modules/indexeddb/idb_database.cc`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/indexeddb/idb_database.cc)）：
    普通的 `IDBDatabase::close()` 仅将 `close_pending_ = true`；只有在收到后端 IPC 回调的 `IDBDatabase::ForcedClose()` 时，才遍历事务触发 `StartAborting` 并执行 `DispatchEvent(*Event::Create(event_type_names::kClose))`。
  - **本地 `fake-indexeddb` 6.2.8**（[`build/esm/lib/closeConnection.js`](https://github.com/dumbmatter/fake-indexeddb/blob/master/src/lib/closeConnection.ts)）：
    ```javascript
    if (forced) {
      const event = new FakeEvent("close", { bubbles: false, cancelable: false });
      connection.dispatchEvent(event);
    }
    ```
    测试套件中仅在调用 `forceCloseDatabase(db)` 时才设置 `forced = true` 并派发 `close`。
- **开发误区**：部分实现试图通过监听 `onclose` 监控所有连接释放，这是错误的；`onclose` 仅充当「底层异常断开与崩溃恢复」的安全网。

### 1.3 `onversionchange` 的标准约束与阻塞链条

- **规范约束**：依据 [W3C IndexedDB 3.0 Section 4.1.4](https://www.w3.org/TR/IndexedDB-3/#dom-idbdatabase-onversionchange)，当同一源下的其它上下文发起更高版本的 `indexedDB.open(name, higherVersion)` 或 `indexedDB.deleteDatabase(name)` 时，所有已建立的长连接都会收到 `versionchange` 事件。
- **阻塞机制**：
  若当前连接在收到 `versionchange` 后未立即调用 `db.close()` 释放句柄，发起升级或删除的请求会被阻塞，其请求对象将触发 `onblocked` 事件，并且升级流程将无限期挂起，直至所有旧连接彻底关闭。
- **最佳实践**：
  每个打开的 `IDBDatabase` 实例必须常驻监听 `db.onversionchange = () => { db.close(); }`。关闭后标记内部长连接单例失效，防止阻碍后续重构或多实例升级。

### 1.4 `InvalidStateError` 与 `AbortError` 的触发条件与防御

- **`InvalidStateError`**：
  依据 [W3C IndexedDB 3.0 Section 4.1.2](https://www.w3.org/TR/IndexedDB-3/#dom-idbdatabase-transaction)，若连接的 `close pending flag` 为 `true` 或底层连接已销毁，调用 `db.transaction(...)` 会**同步直接抛出 `InvalidStateError` DOMException**（而不是通过 Promise reject）。
  - WebKit 源码：
    ```cpp
    if (m_closePending)
        return Exception { ExceptionCode::InvalidStateError, "The database connection is closing."_s };
    ```
  - Blink 源码：
    ```cpp
    if (close_pending_ || !IsConnectionOpen())
        exception_state.ThrowDOMException(DOMExceptionCode::kInvalidStateError, "The database connection is closing.");
    ```
- **`AbortError`**：
  当事务已成功开启，但在异步请求执行或提交阶段，连接被系统强行终止、底层 SQLite/LevelDB 发生 I/O 错误、或页面卸载导致上下文销毁时，事务会被底层中断，触发 `tx.onabort`，错误码为 `AbortError`。
- **防御与重连机制设计**：
  1. **单例 Promise 守卫（防重连风暴）**：绝不能在每次操作捕获到 `InvalidStateError` 时盲目发起 `openDb()`。必须由单例连接管理器维护一个 `dbPromise`；一旦检测到连接关闭或报错，先将 `dbInstance = null; dbPromise = null;`，后续调用排队复用同一初始化 Promise。
  2. **事件监听清理**：在重新开启连接前，彻底卸载旧实例的 `onclose`、`onerror` 与 `onversionchange`，杜绝幽灵回调干扰新连接。
  3. **有限退避与损坏升级**：若重连在指定次数（如 3 次）内因不可恢复错误持续失败，终止重连循环，直接向上抛出并激活应用级损坏恢复界面（提供「重试」与「重置本地数据并重新连接」）。

---

## 2. 独立 `blobs` store 存取：`Uint8Array` vs `Blob` 深度对比

### 2.1 引擎底层存储机制差异

| 引擎 / 环境 | `Uint8Array` 存储形态 | `Blob` 存储形态 | 源码与底层实现依据 |
| :--- | :--- | :--- | :--- |
| **WebKit / macOS WKWebView** | 结构化克隆后作为二进制字节内联写入 SQLite `Records` 表的 `BLOB` 字段 | 脱离 SQLite 主库，独立写入沙盒磁盘文件（`<hash>.blob`），在 SQLite 仅维护 `BlobRecords` 与 `BlobFiles` 映射表 | [`SQLiteIDBBackingStore.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/indexeddb/server/SQLiteIDBBackingStore.cpp)：通过 `AddBlobFilename`、`BlobRecords` 追踪文件，`deleteRecord` 时异步通过 `DeleteUnusedBlobs` 扫盘清理孤立文件 |
| **Chromium / Android WebView** | 结构化克隆后作为字节串直接写入 LevelDB 的 SSTable / WAL 中 | 写入磁盘专用的 IndexedDB Blob 目录（单独文件），LevelDB 的 Value 中仅保存轻量级 Blob 描述元数据 | Chromium `content/browser/indexed_db/` 的 `IndexedDBBackingStore` 分流写入外部 BlobStorage |
| **fake-indexeddb 6.2.8** | 内存对象深拷贝，底层通过 V8/Node 全局 `structuredClone()` 生成新的 TypedArray 实例 | 内存对象深拷贝，通过 `structuredClone()` 克隆 Blob 引用 | [`build/esm/lib/cloneValueForInsertion.js`](https://github.com/dumbmatter/fake-indexeddb/blob/master/src/lib/cloneValueForInsertion.ts)：仅执行 `structuredClone(value)` |

### 2.2 兼容性历史与平台缺陷

- **WebKit / Safari 的 Blob 历史缺陷**：
  IndexedDB 存储 `Blob` 在 WebKit 历史上存在长期稳定性问题（如著名的 WebKit Bug 148387、Bug 168233：IndexedDB 读出 Blob 变为 0 字节、跨进程句柄泄漏甚至崩溃）。虽然现代 macOS/iOS 上的 Modern IndexedDB 已大幅修复，但外部文件与 SQLite 映射之间的断电/异常中断仍然存在元数据孤立风险。
- **`fake-indexeddb` 与测试兼容性**：
  在 Node.js / jsdom 环境下运行 Vitest 单元测试时，`Blob` 的支持依赖运行时环境提供的 Web API。从 `Blob` 恢复为二进制必须通过异步的 `await blob.arrayBuffer()`，在纯同步内存转换逻辑或高频测试中引入了多余的 Promise 流转；而 `Uint8Array` 是 ECMAScript 标准原生类型，在 Node.js、浏览器以及 `fake-indexeddb` 中行为百分之百同构一致。

### 2.3 结构化克隆开销与内存生命周期

- **`Uint8Array` 的开销特性**：
  - **写入**：调用 `store.put(uint8Array)` 时，引擎通过 `StructuredSerializeForStorage` 进行内存快照（C++ 层的内存块 `memcpy`）。对于 Waypoint 面向 Owner 的单张图片或小附件（数 KB 至 5~10MB 范围），现代 JavaScript 引擎（JSC / V8）克隆 5MB 内存耗时在 1~3ms 级别，开销极低。
  - **读取**：`store.get(key)` 直接在 JS 堆内存中分配单份连续内存并返回 `Uint8Array` 视图。
  - **生命周期优势**：Waypoint 内存中的草稿与重试队列附件天然以 `Uint8Array` 存在。使用 `Uint8Array` 保证了通信层、Matrix 媒体直传接口（`fetch` 上传二进制 body）与持久化层之间**零格式转换**，严格践行决策地图 #127 约定的「全程单份 `Uint8Array` 按引用生命周期共享与释放」。
- **`Blob` 的隐性开销**：
  虽然 `Blob` 存入后读取仅返回轻量句柄、不占初始 JS 堆内存，但在向 Matrix Homeserver 上传媒体或进行数据校验时，依然必须通过 `await blob.arrayBuffer()` 或 `FileReader` 将字节流异步拷贝回 JS 堆，凭空增加了一道文件 I/O 往返与 Promise 调度开销。

### 2.4 配额计算

依据 WHATWG Storage 规范，无论以 `Uint8Array` 内联存储在 SQLite/LevelDB 中，还是以独立文件存放在 Blob 目录下，引擎的 `StorageQuotaManager` 均会将磁盘实际占用的字节总额（含数据库文件与外部 blob 文件）全量计入该 Origin 的 Storage Quota。两者在配额判定上没有实质差异。

---

## 3. 版本升级（`onupgradeneeded`）与 `deleteDatabase` 阻塞边界

### 3.1 `versionchange` 事务的强原子性与回滚语义

- **规范保证**：依据 [W3C IndexedDB 3.0 Section 4.1.8](https://www.w3.org/TR/IndexedDB-3/#abort-transaction) 与 [Section 4.1.6](https://www.w3.org/TR/IndexedDB-3/#upgrading-a-database)：
  当升级事务（`mode: "versionchange"`）在执行期间遭遇任何未捕获异常、显式 `transaction.abort()`、或磁盘写满抛出 `QuotaExceededError` 时：
  1. 数据库版本号自动退回升级前状态（回退至 v1）。
  2. 升级期间调用的所有 `createObjectStore` 与 `deleteObjectStore` 全部撤销。
  3. 写入新 store 或修改旧 store 的所有记录全部回滚，旧数据保持完好无损。
  4. 请求触发 `openRequest.onerror`，数据库连接绝不会被打开。
- **源码与测试验证**：
  - WebKit 底层将整个升级过程包装于 SQLite 事务中，出错时触发 `ROLLBACK`。
  - `fake-indexeddb` 6.2.8 的 [`FDBTransaction.js`](https://github.com/dumbmatter/fake-indexeddb/blob/master/src/FDBTransaction.ts) 源码完整维护了一个倒序回滚栈 `_rollbackLog`：
    ```javascript
    _abort(errName) {
      for (const f of this._rollbackLog.reverse()) {
        f();
      }
      if (errName !== null) {
        this.error = new DOMException(undefined, errName);
      }
      // ...
    }
    ```
    当触发 abort 时，新建的 `rawObjectStore.deleted = true`，作用域和 schema 自动回退。
- **架构价值**：从 v1（单 key 巨型 `session` 记录）升级到 v2（拆分为 `records`、`rooms`、`drafts`、`blobs` 等细粒度 store）时，升级过程具备数据库级事务原子性保护，绝不会因为半途 crash 或配额耗尽产生损坏的中间态。

### 3.2 `onblocked` 产生条件与死锁风险

- **触发条件**：
  1. 升级时：调用 `indexedDB.open(DB_NAME, 2)` 时，若进程内尚有未执行 `db.close()` 的 v1 数据库连接，新请求立即触发 `onblocked` 并挂起。
  2. 删库时：调用 `indexedDB.deleteDatabase(DB_NAME)` 时，若存在任何打开的该库连接，删除请求同样触发 `onblocked` 并挂起。
- **防御约束**：
  - 在执行 `deleteDatabase`（如 Owner 点击「重置本地数据并重新连接」或「退出这台设备」）之前，**必须首先显式关闭当前持有的所有 `IDBDatabase` 长连接**。
  - 在 `deleteDatabase` 请求上必须绑定 `onblocked` 处理器并设置超时保护（如 3000ms），一旦发生阻塞立即记录警告，避免整个应用的重置操作无限挂起。

### 3.3 大事务迁移陷阱：事件循环与微任务约束

- **致命规则：`onupgradeneeded` 严禁逃逸到宏任务！**
  依据 W3C 规范，IndexedDB 事务是事件循环驱动的。在 `onupgradeneeded` 回调函数同步执行完毕后，一旦当前微任务队列清空且没有活跃的在途 `IDBRequest`，引擎会自动尝试提交该事务！
  - **错误写法**：在 `onupgradeneeded` 中执行 `await fetch(...)` 或 `setTimeout`。这会导致宏任务排队期间事务被浏览器自动 commit，宏任务返回后再调用 `store.put()` 就会抛出 `TransactionInactiveError`！
  - **正确写法**：所有迁移必须通过同事务内的 `request.onsuccess` 或标准 Promise 链保持在途请求链条不中断；或者将旧数据保留在原 store，升级仅完成 object stores 的同步创建，将复杂的数据拆分迁移留到数据库成功打开（`onsuccess`）后的普通只读/读写事务中进行。

---

## 4. 生命周期落盘窗口（`visibilitychange` / `pagehide`）与草稿防抖约束

### 4.1 现代生命周期事件演进与移动端不可靠性

- **`beforeunload` / `unload` 的淘汰**：
  WHATWG 标准与各大浏览器引擎已正式将 `unload` 标记为 Deprecated。在 iOS WKWebView 与 Android WebView 上，当用户切回手机主屏幕、锁屏或切换到其它 App 时，`beforeunload` 和 `unload` **几乎从不触发**。
- **标准生命周期链条**：
  依据 W3C Page Lifecycle 标准，唯一受到双端可靠保证的生命周期信号是：
  `visibilitychange`（当 `document.visibilityState === 'hidden'`）以及紧随其后的 `pagehide`。

### 4.2 异步 IndexedDB 写入事务在挂起窗口中的提交可靠性

- **执行窗口与风险分析**：
  当应用切后台触发 `visibilitychange(hidden)` 时，虽然 JS 主线程仍可执行代码，但移动操作系统（iOS / Android）留给后台的执行窗口极短（从数十毫秒到数秒不等）。
  - 若在 `visibilitychange` 回调中调用 `db.transaction(['drafts'], 'readwrite').objectStore('drafts').put(draft)`，发起请求是同步入队的。
  - 但是：从事务请求到底层磁盘完成 I/O 刷盘（`fsync`）是异步的。若用户直接在多任务管理器划掉应用进程（Swipe-to-kill）或操作系统触发极端内存杀死，未完成 `commit` 的事务将在底层回滚，导致草稿落盘丢失。
- **显式 `tx.commit()` 的加速语义**：
  依据 [W3C IndexedDB 3.0 Section 4.2.1](https://www.w3.org/TR/IndexedDB-3/#dom-idbtransaction-commit)：
  传统事务需等待当前宏任务的所有微任务清空并由浏览器隐式判定提交；而 `transaction.commit()` 允许开发者显式标记事务完成，立即向底层存储服务发起提交指令。
  - **引擎支持**：WebKit（[`IDBTransaction::commit()`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/indexeddb/IDBTransaction.cpp)）与 Chromium（Blink 从 Chrome 76+ 起）以及 `fake-indexeddb` 6.x 均已全面原生支持 `commit()`。在生命周期即将切入后台时，写入数据后立即调用 `tx.commit()` 能最大化利用有限的存活窗口。

### 4.3 草稿防抖时间窗口与 Flush 硬约束

基于双端生命周期机制，针对草稿持久化的防抖设计必须遵循以下四项硬约束：

1. **防抖时间窗口收紧（300ms ~ 500ms）**：
   防抖窗口绝不能过长（如 > 1000ms）。Owner 在输入草稿后通常会在极短时间内切出应用。将草稿防抖窗口定在 **300ms ~ 500ms**（上限不超过 1000ms），能够使绝大多数输入的落盘在用户尚未切后台前即已静默完成。
2. **切后台立即取消防抖并强制 Flush（Immediate Flush on Hidden）**：
   必须全局监听 `document.addEventListener('visibilitychange', ...)` 与 `window.addEventListener('pagehide', ...)`。一旦检测到 `document.visibilityState === 'hidden'`，若当前内存中存在未落盘的草稿变动（`isDirty = true`），**必须立即清理防抖定时器，并以同步调用开启事务立即写入并调用 `tx.commit()`**。
3. **用户确定性行为跳过防抖（Bypass Debounce）**：
   当 Owner 触发发送消息、点击切换 Topic、删除草稿或清空文本时，立即无延迟执行持久化/清理，绝不通过防抖队列排队。
4. **Tauri 2 桌面端窗口关闭兜底**：
   在 macOS 桌面端，结合 Tauri 2 窗口生命周期事件（`appWindow.onCloseRequested`），在窗口销毁前等待草稿与挂起事务 flush 完成再放行关闭，构建双重安全保障。

---

## 5. 存储配额、驱逐策略与持久化申请（Storage Quota & Persistence）

### 5.1 WHATWG Storage 标准模型

依据 [WHATWG Storage Standard](https://storage.spec.whatwg.org/)：
- **`best-effort`（尽力而为，默认）**：当设备遭遇磁盘空间严重告急时，浏览器引擎有权按照特定淘汰算法（LRU）驱逐该 Origin 下的非持久存储。
- **`persistent`（持久存储）**：引擎保证不会在未经用户明确操作的情况下静默驱逐该源的数据。
- 提供核心 API：`navigator.storage.estimate()`（查询使用量与配额）、`navigator.storage.persist()`（申请持久化）、`navigator.storage.persisted()`（查询持久化状态）。

### 5.2 WKWebView 实际支持度与源码机制

- **`navigator.storage.persist()` 返回 `false` 的源码根源**：
  在 WebKit 源码（[`Source/WebKit/NetworkProcess/storage/NetworkStorageManager.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/storage/NetworkStorageManager.cpp)）中，`persistOrigin` 函数的逻辑如下：
  ```cpp
  bool NetworkStorageManager::persistOrigin(const WebCore::ClientOrigin& origin)
  {
      assertIsCurrent(workQueue());
      ASSERT(m_domainsExemptFromEviction);

      if (!m_domainsExemptFromEviction->contains(origin.clientRegistrableDomain())) {
          auto persistedFile = persistedFilePath(origin);
          if (!persistedFile.isEmpty())
              FileSystem::deleteFile(persistedFile);
          return false;
      }

      return !FileSystem::overwriteEntireFile(persistedFilePath(origin), std::span<uint8_t> { });
  }
  ```
  WebKit 要求被持久化的 Origin 必须存在于 `m_domainsExemptFromEviction` 白名单中。该白名单在系统原生 Safari 中通常只对添加到主屏幕的 PWA 或高频书签开放。
  在嵌入原生应用的 **WKWebView**（特别是 Tauri 采用的 `tauri://localhost` 或本地自定义协议）中，调用 `navigator.storage.persist()` **将无条件返回 `false`**。
- **原生沙盒提供的天然持久性**：
  虽然 API 返回 `false`，但 WKWebView 的数据保存在当前 Native App 独立的私有沙盒容器中（如 macOS 下的 `~/Library/Containers/<bundle-id>/Data/Library/WebKit/WebsiteData/`）。只要用户不主动卸载 App 或清除数据，操作系统不会将其作为浏览器临时缓存按日清空，天然具备独立性。

### 5.3 Android WebView 实际支持度与系统机制

- **API 表现**：
  在 Android WebView 下，由于缺乏独立浏览器的用户权限弹窗与 Site Engagement 计算，`navigator.storage.persist()` 通常同样返回 `false`。
- **系统级持久化保障**：
  Android 系统将 WebView 的 IndexedDB 文件存放在当前 App 的私有数据空间（`/data/data/<package_name>/app_webview/Default/IndexedDB/`）。
  Android 操作系统在磁盘不足时，清理机制仅针对 Cache 目录（`/cache` 或 `/data/data/<package_name>/cache`）；对于 `/data/data/<package_name>/` 下的持久化数据库目录，Android 系统**绝对不会擅自静默驱逐**，除非用户进入系统设置主动点击「清除存储空间」或卸载应用。

### 5.4 配额监控与 `QuotaExceededError` 容错

- **默认配额**：
  现代 WKWebView 与 Chromium Android WebView 的默认配额均相当充裕（通常为可用磁盘空间的相当比例，在 Android WebView 上可达可用分区的 60% 以上）。
- **最佳实践要求**：
  1. 应用在启动或连接时可**尽力而为（best-effort）**调用一次 `navigator.storage.persist()`，但**严禁依赖其返回值**作为业务逻辑前置门禁。
  2. 在所有写盘操作（`saveSession`、草稿保存、二进制附件入库）中，必须显式捕获 `QuotaExceededError`，向 Owner 提示设备存储空间不足，严禁发生未捕获异常导致客户端白屏。

---

## 6. 对后续决策（#127 / #124）的直接结论

基于上述五项一手调研事实，为后续实现规格与架构决策提供以下确定性支撑：

1. **连接管理机制**：
   - 摒弃 v1 每次读写 `openDb() -> db.close()` 的开销，采用**全局单例长连接**。
   - 长连接实例必须绑定 `onversionchange = () => { db.close(); }`，确保未来升级或重置时无阻塞。
   - 监听 `onclose` 捕获底层崩溃；遇到 `InvalidStateError` 或 `AbortError` 时，通过单例 Promise 守卫进行带重试上限的重连，杜绝并发重连风暴。
2. **附件存储方案**：
   - 坚决落实决策地图 #127 约束：**建立独立的 `blobs` store，存取原生 `Uint8Array`**。
   - 彻底绕开 `Blob` 在 WebKit 历史上的稳定性陷阱，避免 `Blob` 与 `ArrayBuffer` 之间的异步转换，在通信层、Matrix 媒体上传与 Vitest `fake-indexeddb` 测试中保持全流程同构与零开销。
3. **版本平滑升级（v1 -> v2）**：
   - 在 `onupgradeneeded` 中一次性同步创建新 stores（`records`、`rooms`、`drafts`、`blobs` 等），利用升级事务的底层强原子性确保 schema 变更万无一失。
   - 升级回调内严禁引入任何宏任务（禁止 `setTimeout` 或脱离事务的外部异步操作），保证升级事务紧凑提交。
4. **草稿防抖与落盘窗口**：
   - 草稿输入防抖窗口设定为 **300ms ~ 500ms**（上限不超过 1000ms）。
   - 全局注册 `visibilitychange`（`hidden`）与 `pagehide` 监听器，一旦切后台立即中断防抖计时器，执行**同步开启事务写入并显式调用 `tx.commit()`**。
   - 发送消息、切换 Topic、删除草稿等确定性行为立即写入/清理，不走防抖。
5. **存储配额与容错**：
   - 启动时尽力而为调用 `navigator.storage.persist()` 但不依赖其结果；双端持久性完全由 Native App 私有沙盒保证。
   - 在写盘关键链路中严格捕获 `QuotaExceededError`，并对数据库损坏或致命异常回退至地图 #127 约定的恢复 UI（展示「重试」与「重置本地数据并重新连接」）。
