export const title = "Codepath service ownership and accepted saves";
export function state(v) {
  const phases = Object.values(v.phase);
  const owners = phases.filter((phase) => phase === "owner").length;
  const broken = [];
  if (owners > 1) broken.push("Two writable owners");
  if (v.acceptedPaths.some((id) => !v.diskPaths.includes(id)))
    broken.push("An accepted save disappeared");
  if (!v.foreignConnectionPreserved) broken.push("Foreign connection removed");
  if (broken.length) return broken.join("; ");
  if (phases.every((phase) => ["closed", "blocked"].includes(phase)))
    return phases.includes("blocked")
      ? "Finished with a blocked attempt"
      : "All handles closed";
  if (
    phases.some((phase) =>
      ["closing", "draining", "drained", "releasing"].includes(phase)
    )
  )
    return "Closing admission and draining before release";
  if (v.foreignUsed) return "Foreign record installed before close";
  if (owners) {
    if (v.acceptedPaths.length === 2)
      return "One owner; both accepted saves retained";
    if (v.acceptedPaths.length === 1)
      return "One owner; first accepted save retained";
    if (
      phases.some((phase) =>
        ["discover", "acquire", "probe", "reprobe"].includes(phase)
      )
    )
      return "One owner; another start discovers or waits";
    return "One writable owner";
  }
  if (phases.some((phase) => ["probe", "reprobe"].includes(phase)))
    return "Rechecking the old owner's connection";
  if (
    phases.some((phase) =>
      ["readyToPublish", "publicationChecked"].includes(phase)
    )
  )
    return "HTTP ready; publication still pending";
  if (v.reservation.length) return "Startup claim; HTTP not ready";
  if (
    phases.some((phase) => ["discover", "acquire", "recheck"].includes(phase))
  )
    return "Discovering or waiting for a reservation";
  return "No writable owner";
}
export function step(action) {
  return (
    {
      BeginStart: "Start Codepath",
      ReadDiscovery: "Read the current connection",
      AcquireReservation: "Acquire a root claim",
      ReservationBusy: "Retry discovery while reservation is busy",
      ReservationTimeout: "Stop this attempt at its deadline",
      AttachToOwner: "Attach to the published owner",
      ProbeRecordChanged: "Probe finishes after the old connection changed",
      ProbeFailedLivePid: "Fail closed on an unchanged live PID",
      ReleaseNonOwner: "Release the unused reservation",
      LoadWorkspace: "Continue with this start's workspace snapshot",
      ListenerReady: "The real HTTP listener becomes ready",
      CheckPublication: "Check connection identity before rename",
      PublicationRejected: "Reject unexpected connection replacement",
      PublishConnection: "Publish and admit writes",
      BeginSave: "Await an authenticated request body",
      SaveWalkthrough: "Acknowledge a persisted new path",
      RejectPending: "Reject a pending body after admission closes",
      CloseAdmission: "Close writable admission",
      StopHttp: "Stop HTTP and destroy incomplete sockets",
      DrainHandlers: "Wait for all handlers to settle",
      RemoveConnection: "Finish connection cleanup",
      ReleaseReservation: "Release the reservation last",
      CloseAttached: "Close the attached handle without stopping its owner",
      ReplaceWithForeignRecord:
        "Environment replaces the published token record",
    }[action] ?? null
  );
}
