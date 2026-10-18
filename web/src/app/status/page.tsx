import type { Metadata } from "next";
import { StatusChecks } from "./status-checks";

export const metadata: Metadata = { title: "Status · HUGIN" };

export default function StatusPage() {
  return (
    <main className="page" style={{ maxWidth: 720, margin: "0 auto", width: "100%" }}>
      <div className="ph">
        <div>
          <h2>Connection status</h2>
          <p>Checks that this app can reach your Firebase project. Development page only.</p>
        </div>
      </div>
      <StatusChecks />
    </main>
  );
}
