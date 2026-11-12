import { useMemo } from "react";
import { detectPlatform, createFetchTransport, systemClock } from "./adapters/production";
import { WaypointApp } from "./waypoint/WaypointApp";
import "./App.css";

export default function App() {
  const homeserver = useMemo(() => createFetchTransport(), []);
  const platform = useMemo(() => detectPlatform(), []);
  return (
    <WaypointApp
      homeserver={homeserver}
      platform={platform}
      clock={systemClock}
    />
  );
}
