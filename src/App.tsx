import { detectPlatform, createFetchTransport, systemClock } from "./adapters/production";
import { WaypointApp } from "./waypoint/WaypointApp";
import "./App.css";

export default function App() {
  return (
    <WaypointApp
      homeserver={createFetchTransport()}
      platform={detectPlatform()}
      clock={systemClock}
    />
  );
}
