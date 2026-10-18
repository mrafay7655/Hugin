// Stops leftover Firebase *Firestore emulator* Java processes from an interrupted run.
// It only touches processes whose command line contains the emulator jar name.
import { execFileSync } from "node:child_process";

if (process.platform === "win32") {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='java.exe'" | Where-Object { $_.CommandLine -match 'cloud-firestore-emulator' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped " + $_.ProcessId }`;
  const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim();
  if (out) console.log(out);
} else {
  try {
    execFileSync("pkill", ["-f", "cloud-firestore-emulator"]);
    console.log("stopped stale Firestore emulator");
  } catch {
    /* none running */
  }
}
