------------------------- MODULE ServiceOwnership -------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Participants, NoOwner, Foreign, ExclusiveReservation,
          FreshSnapshot, RequireOwnerToken
VARIABLES phase, reservation, listenerUp, observedConnection, requestOwner,
          pendingOwner, workspacePaths, diskPaths, acceptedPaths, connection,
          foreignUsed, foreignConnectionPreserved

vars == <<phase, reservation, listenerUp, observedConnection, requestOwner,
          pendingOwner, workspacePaths, diskPaths, acceptedPaths, connection,
          foreignUsed, foreignConnectionPreserved>>

Init ==
  /\ phase = [c \in Participants |-> "notStarted"]
  /\ reservation = {}
  /\ listenerUp = [c \in Participants |-> FALSE]
  /\ observedConnection = [c \in Participants |-> NoOwner]
  /\ requestOwner = [c \in Participants |-> NoOwner]
  /\ pendingOwner = [c \in Participants |-> NoOwner]
  /\ workspacePaths = [c \in Participants |-> {}]
  /\ diskPaths = {}
  /\ acceptedPaths = {}
  /\ connection = NoOwner
  /\ foreignUsed = FALSE
  /\ foreignConnectionPreserved = TRUE

BeginStart(c) ==
  /\ phase[c] = "notStarted"
  /\ phase' = [phase EXCEPT ![c] = "discover"]
  /\ workspacePaths' = IF FreshSnapshot THEN workspacePaths
       ELSE [workspacePaths EXCEPT ![c] = diskPaths]
  /\ UNCHANGED <<reservation, listenerUp, observedConnection, requestOwner,
       pendingOwner, diskPaths, acceptedPaths, connection, foreignUsed,
       foreignConnectionPreserved>>

ReadDiscovery(c) ==
  /\ phase[c] \in {"discover", "recheck"}
  /\ observedConnection' = [observedConnection EXCEPT ![c] = connection]
  /\ phase' = [phase EXCEPT ![c] =
       IF connection = Foreign THEN
         (IF c \in reservation THEN "releaseBlocked" ELSE "blocked")
       ELSE IF connection = NoOwner THEN
         (IF c \in reservation THEN "claimed" ELSE "acquire")
       ELSE (IF c \in reservation THEN "reprobe" ELSE "probe")]
  /\ UNCHANGED <<reservation, listenerUp, requestOwner, pendingOwner,
       workspacePaths, diskPaths, acceptedPaths, connection, foreignUsed,
       foreignConnectionPreserved>>

AcquireReservation(c) ==
  /\ phase[c] = "acquire"
  /\ ~ExclusiveReservation \/ reservation = {}
  /\ reservation' = reservation \cup {c}
  /\ phase' = [phase EXCEPT ![c] = "recheck"]
  /\ UNCHANGED <<listenerUp, observedConnection, requestOwner, pendingOwner,
       workspacePaths, diskPaths, acceptedPaths, connection, foreignUsed,
       foreignConnectionPreserved>>

ReservationBusy(c) ==
  /\ phase[c] = "acquire"
  /\ ExclusiveReservation /\ reservation # {}
  /\ phase' = [phase EXCEPT ![c] = "discover"]
  /\ UNCHANGED <<reservation, listenerUp, observedConnection, requestOwner,
       pendingOwner, workspacePaths, diskPaths, acceptedPaths, connection,
       foreignUsed, foreignConnectionPreserved>>

ReservationTimeout(c) ==
  /\ phase[c] = "acquire"
  /\ ExclusiveReservation /\ reservation # {}
  /\ phase' = [phase EXCEPT ![c] = "blocked"]
  /\ UNCHANGED <<reservation, listenerUp, observedConnection, requestOwner,
       pendingOwner, workspacePaths, diskPaths, acceptedPaths, connection,
       foreignUsed, foreignConnectionPreserved>>

AttachToOwner(c) ==
  /\ phase[c] \in {"probe", "reprobe"}
  /\ observedConnection[c] \in Participants
  /\ connection = observedConnection[c]
  /\ listenerUp[observedConnection[c]]
  /\ requestOwner' = [requestOwner EXCEPT ![c] = observedConnection[c]]
  /\ phase' = [phase EXCEPT ![c] =
       IF c \in reservation THEN "attachedReserved" ELSE "attached"]
  /\ UNCHANGED <<reservation, listenerUp, observedConnection, pendingOwner,
       workspacePaths, diskPaths, acceptedPaths, connection, foreignUsed,
       foreignConnectionPreserved>>

ProbeRecordChanged(c) ==
  /\ phase[c] \in {"probe", "reprobe"}
  /\ connection # observedConnection[c]
  /\ phase' = [phase EXCEPT ![c] =
       IF c \in reservation THEN "recheck" ELSE "discover"]
  /\ UNCHANGED <<reservation, listenerUp, observedConnection, requestOwner,
       pendingOwner, workspacePaths, diskPaths, acceptedPaths, connection,
       foreignUsed, foreignConnectionPreserved>>

ProbeFailedLivePid(c) ==
  /\ phase[c] \in {"probe", "reprobe"}
  /\ observedConnection[c] \in Participants
  /\ connection = observedConnection[c]
  /\ ~listenerUp[observedConnection[c]]
  /\ phase' = [phase EXCEPT ![c] =
       IF c \in reservation THEN "releaseBlocked" ELSE "blocked"]
  /\ UNCHANGED <<reservation, listenerUp, observedConnection, requestOwner,
       pendingOwner, workspacePaths, diskPaths, acceptedPaths, connection,
       foreignUsed, foreignConnectionPreserved>>

ReleaseNonOwner(c) ==
  /\ phase[c] \in {"attachedReserved", "releaseBlocked"}
  /\ reservation' = reservation \ {c}
  /\ phase' = [phase EXCEPT ![c] =
       IF @ = "attachedReserved" THEN "attached" ELSE "blocked"]
  /\ UNCHANGED <<listenerUp, observedConnection, requestOwner, pendingOwner,
       workspacePaths, diskPaths, acceptedPaths, connection, foreignUsed,
       foreignConnectionPreserved>>

LoadWorkspace(c) ==
  /\ phase[c] = "claimed"
  /\ workspacePaths' = IF FreshSnapshot
       THEN [workspacePaths EXCEPT ![c] = diskPaths] ELSE workspacePaths
  /\ phase' = [phase EXCEPT ![c] = "waitingForListen"]
  /\ UNCHANGED <<reservation, listenerUp, observedConnection, requestOwner,
       pendingOwner, diskPaths, acceptedPaths, connection, foreignUsed,
       foreignConnectionPreserved>>

ListenerReady(c) ==
  /\ phase[c] = "waitingForListen"
  /\ listenerUp' = [listenerUp EXCEPT ![c] = TRUE]
  /\ phase' = [phase EXCEPT ![c] = "readyToPublish"]
  /\ UNCHANGED <<reservation, observedConnection, requestOwner, pendingOwner,
       workspacePaths, diskPaths, acceptedPaths, connection, foreignUsed,
       foreignConnectionPreserved>>

CheckPublication(c) ==
  /\ phase[c] = "readyToPublish"
  /\ connection = observedConnection[c]
  /\ phase' = [phase EXCEPT ![c] = "publicationChecked"]
  /\ UNCHANGED <<reservation, listenerUp, observedConnection, requestOwner,
       pendingOwner, workspacePaths, diskPaths, acceptedPaths, connection,
       foreignUsed, foreignConnectionPreserved>>

PublicationRejected(c) ==
  /\ phase[c] = "readyToPublish"
  /\ connection # observedConnection[c]
  /\ phase' = [phase EXCEPT ![c] = "closing"]
  /\ UNCHANGED <<reservation, listenerUp, observedConnection, requestOwner,
       pendingOwner, workspacePaths, diskPaths, acceptedPaths, connection,
       foreignUsed, foreignConnectionPreserved>>

PublishConnection(c) ==
  /\ phase[c] = "publicationChecked"
  /\ connection' = c
  /\ requestOwner' = [requestOwner EXCEPT ![c] = c]
  /\ phase' = [phase EXCEPT ![c] = "owner"]
  /\ UNCHANGED <<reservation, listenerUp, observedConnection, pendingOwner,
       workspacePaths, diskPaths, acceptedPaths, foreignUsed,
       foreignConnectionPreserved>>

BeginSave(c) ==
  /\ phase[c] \in {"owner", "attached"}
  /\ c \notin acceptedPaths /\ pendingOwner[c] = NoOwner
  /\ requestOwner[c] \in Participants
  /\ phase[requestOwner[c]] = "owner" /\ listenerUp[requestOwner[c]]
  /\ pendingOwner' = [pendingOwner EXCEPT ![c] = requestOwner[c]]
  /\ UNCHANGED <<phase, reservation, listenerUp, observedConnection,
       requestOwner, workspacePaths, diskPaths, acceptedPaths, connection,
       foreignUsed, foreignConnectionPreserved>>

SaveWalkthrough(c) ==
  /\ pendingOwner[c] \in Participants
  /\ phase[pendingOwner[c]] = "owner" /\ listenerUp[pendingOwner[c]]
  /\ LET saved == workspacePaths[pendingOwner[c]] \cup {c}
     IN /\ workspacePaths' = [workspacePaths EXCEPT ![pendingOwner[c]] = saved]
        /\ diskPaths' = saved
  /\ acceptedPaths' = acceptedPaths \cup {c}
  /\ pendingOwner' = [pendingOwner EXCEPT ![c] = NoOwner]
  /\ UNCHANGED <<phase, reservation, listenerUp, observedConnection,
       requestOwner, connection, foreignUsed, foreignConnectionPreserved>>

RejectPending(c) ==
  /\ pendingOwner[c] \in Participants
  /\ phase[pendingOwner[c]] # "owner" \/ ~listenerUp[pendingOwner[c]]
  /\ pendingOwner' = [pendingOwner EXCEPT ![c] = NoOwner]
  /\ UNCHANGED <<phase, reservation, listenerUp, observedConnection,
       requestOwner, workspacePaths, diskPaths, acceptedPaths, connection,
       foreignUsed, foreignConnectionPreserved>>

CloseAdmission(c) ==
  /\ phase[c] = "owner"
  /\ phase' = [phase EXCEPT ![c] = "closing"]
  /\ UNCHANGED <<reservation, listenerUp, observedConnection, requestOwner,
       pendingOwner, workspacePaths, diskPaths, acceptedPaths, connection,
       foreignUsed, foreignConnectionPreserved>>

StopHttp(c) ==
  /\ phase[c] = "closing"
  /\ phase' = [phase EXCEPT ![c] = "draining"]
  /\ listenerUp' = [listenerUp EXCEPT ![c] = FALSE]
  /\ UNCHANGED <<reservation, observedConnection, requestOwner, pendingOwner,
       workspacePaths, diskPaths, acceptedPaths, connection, foreignUsed,
       foreignConnectionPreserved>>

DrainHandlers(c) ==
  /\ phase[c] = "draining"
  /\ \A client \in Participants : pendingOwner[client] # c
  /\ phase' = [phase EXCEPT ![c] = "drained"]
  /\ UNCHANGED <<reservation, listenerUp, observedConnection, requestOwner,
       pendingOwner, workspacePaths, diskPaths, acceptedPaths, connection,
       foreignUsed, foreignConnectionPreserved>>

RemoveConnection(c) ==
  /\ phase[c] = "drained"
  /\ LET remove == ~RequireOwnerToken \/ connection = c
         next == IF remove THEN NoOwner ELSE connection
     IN /\ connection' = next
        /\ foreignConnectionPreserved' = (foreignConnectionPreserved /\
             (IF connection # NoOwner /\ connection # c
              THEN next = connection ELSE TRUE))
  /\ phase' = [phase EXCEPT ![c] = "releasing"]
  /\ UNCHANGED <<reservation, listenerUp, observedConnection, requestOwner,
       pendingOwner, workspacePaths, diskPaths, acceptedPaths, foreignUsed>>

ReleaseReservation(c) ==
  /\ phase[c] = "releasing"
  /\ reservation' = reservation \ {c}
  /\ phase' = [phase EXCEPT ![c] = "closed"]
  /\ UNCHANGED <<listenerUp, observedConnection, requestOwner, pendingOwner,
       workspacePaths, diskPaths, acceptedPaths, connection, foreignUsed,
       foreignConnectionPreserved>>

CloseAttached(c) ==
  /\ phase[c] = "attached"
  /\ phase' = [phase EXCEPT ![c] = "closed"]
  /\ UNCHANGED <<reservation, listenerUp, observedConnection, requestOwner,
       pendingOwner, workspacePaths, diskPaths, acceptedPaths, connection,
       foreignUsed, foreignConnectionPreserved>>

ReplaceWithForeignRecord ==
  /\ ~foreignUsed /\ connection \in Participants
  /\ phase[connection] = "owner"
  /\ connection' = Foreign /\ foreignUsed' = TRUE
  /\ UNCHANGED <<phase, reservation, listenerUp, observedConnection,
       requestOwner, pendingOwner, workspacePaths, diskPaths, acceptedPaths,
       foreignConnectionPreserved>>

Done ==
  /\ \A c \in Participants : phase[c] \in {"closed", "blocked"}
  /\ \A c \in Participants : pendingOwner[c] = NoOwner
  /\ UNCHANGED vars

Next == (\E c \in Participants :
  BeginStart(c) \/ ReadDiscovery(c) \/ AcquireReservation(c) \/
  ReservationBusy(c) \/ ReservationTimeout(c) \/ AttachToOwner(c) \/
  ProbeRecordChanged(c) \/ ProbeFailedLivePid(c) \/ ReleaseNonOwner(c) \/
  LoadWorkspace(c) \/ ListenerReady(c) \/ CheckPublication(c) \/
  PublicationRejected(c) \/ PublishConnection(c) \/ BeginSave(c) \/
  SaveWalkthrough(c) \/ RejectPending(c) \/ CloseAdmission(c) \/
  StopHttp(c) \/ DrainHandlers(c) \/ RemoveConnection(c) \/
  ReleaseReservation(c) \/ CloseAttached(c)) \/ ReplaceWithForeignRecord \/ Done

ProtocolOnlyView == ~foreignUsed

FailedProbeFreshnessSchedule ==
  (acceptedPaths = {} /\ acceptedPaths' # {}) =>
    (\E c \in Participants : phase[c] = "probe" /\
      observedConnection[c] \in Participants /\
      observedConnection[c] \in acceptedPaths')

TypeOK ==
  /\ phase \in [Participants -> {"notStarted", "discover", "acquire", "recheck",
       "probe", "reprobe", "claimed", "attachedReserved", "attached",
       "releaseBlocked", "blocked", "waitingForListen", "readyToPublish",
       "publicationChecked", "owner", "closing", "draining", "drained",
       "releasing", "closed"}]
  /\ reservation \subseteq Participants
  /\ listenerUp \in [Participants -> BOOLEAN]
  /\ observedConnection \in [Participants -> Participants \cup {NoOwner, Foreign}]
  /\ requestOwner \in [Participants -> Participants \cup {NoOwner}]
  /\ pendingOwner \in [Participants -> Participants \cup {NoOwner}]
  /\ workspacePaths \in [Participants -> SUBSET Participants]
  /\ diskPaths \subseteq Participants /\ acceptedPaths \subseteq Participants
  /\ connection \in Participants \cup {NoOwner, Foreign}
  /\ foreignUsed \in BOOLEAN /\ foreignConnectionPreserved \in BOOLEAN

AtMostOneLiveOwner ==
  Cardinality({c \in Participants : phase[c] = "owner" /\ listenerUp[c]}) <= 1
AcceptedPathsPreserved == acceptedPaths \subseteq diskPaths
ForeignConnectionPreserved == foreignConnectionPreserved
=============================================================================
