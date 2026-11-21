# Domain and State Machines

`packages/domain` owns pure identity, authorization, task lifecycle, leases, and ledgers. `packages/kernel` owns orchestration rules and runtime ports for the contact round, Compute, retry, and plugin boundaries. `packages/adapter-sqlite` implements durable storage beneath the server assembly.

Keep I/O outside domain and kernel source. Persist state transitions through their owning stores. Use explicit stable primary keys and `WITHOUT ROWID` for new append-only history tables. Run the state machine and persistence tests when changing transitions or storage and run `npm run check:structure` for the import boundary.

The group checklist projects the existing Task document. A claim compares the revision read by the contact, takes ownership by task ID, and commits the contact's room message in the same transaction. Releasing a running task returns it to the open state after Compute confirms it stopped. Each subsequent claim uses a fresh launch request ID. A room user may reassign a claimed task before Compute starts. Delivery, user acceptance, and user-requested rework follow the existing task lifecycle.
