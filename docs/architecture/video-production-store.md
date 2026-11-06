# Video Studio production store

[← Architecture](README.md)

The production store (`src/lib/video/production/store/`, WS1 #118) keeps Video Studio productions on disk.
Each production's document, its bounded undo and redo history, its named versions and any open agent run survive a restart.
The Production API ([video-production-api.md](video-production-api.md)) is its only caller; no UI uses it yet.

## Layout

```text
data/video/<productionId>/
  journal/<generation>.json   immutable state records; the highest generation is current
  snapshots/<sha256>.json     immutable production documents, named by content hash
  tmp/                        files being written; never read
  quarantine/                 copies of damaged files, kept by explicit recovery
```

A journal record is the complete persisted state of one production: the current document, the undo and redo steps, the named versions and the open run.
It refers to every document by hash, so a record is small, and a document shared by many records is stored once.
Records carry `format` and `formatVersion` (1); documents carry the Production `schemaVersion`.
Media bytes are never stored here: documents refer to media by hash only.

## One mutation path

The store adds no editing logic.
Every change is decided by the change-set engine from #115 (`applyToHistory`, `undo`, `redo`, `labelRevision`, `restoreLabel`, `beginRun`, `endRun`), which admits each new document through `admitProduction()`.
When the store is given a `ledger` (the [media registry](video-media-registry.md), as `apiContext()` does), every state it creates, changes, undoes, redoes, restores from a label or decides for an agent run is admitted against it.
When it is also given a capability catalog (`capabilities`, as `apiContext()` does), the parameters of every graphics clip whose capability the catalog knows must pass that capability's own check; unknown capabilities stay admissible and are refused only at [export](video-rendering.md#capabilities).
States already stored are read without this check, but nothing can be committed on top of a state whose parameters are invalid.
Stored states are read without it, and explicit recovery recommits an earlier stored state as it was.
The store only loads the current state and persists what the engine returns.
Every document is admitted again when it is read, and its content must match its hash.

## Commit protocol

To move from generation G to G+1:

1. load record G and its documents;
2. run the engine; a conflict or rejection ends here and writes nothing;
3. write each new document to `tmp/`, fsync it, and hard-link it to `snapshots/<hash>.json`, then fsync that directory;
4. write record G+1 to `tmp/`, fsync it, and hard-link it to `journal/<G+1>.json`;
5. fsync the journal directory.

Step 4 is the commit point.
`link()` fails with `EEXIST` if the target exists, atomically and in every process, so exactly one writer can create generation G+1.
A writer that loses reloads the new state and runs the engine again, so a change set's `baseRevision` is always checked against the state it is committed on top of.
A stale change set comes back as the engine's `stale_revision` conflict; a change that is still valid, for example after another writer only added a label, is committed on top.
After eight lost attempts in a row the store answers `contended`.

## Concurrency guarantee

- **Several processes:** two writers, in one process or in several, can never both commit the same generation, and so can never overwrite each other.
  This holds without any lock, so there is no stale lock to detect or break: a process that dies mid-write leaves at most an unreferenced temporary file or document.
  `tests/production-store-processes.test.ts` checks this with real OS processes. In those tests, six processes race, and every applied change is a distinct revision with no lost update. Five processes submit against one revision, and exactly one succeeds. Processes killed with SIGKILL mid-edit always leave a readable production.
- **One process:** a mutex per production and store instance serialises that instance's writers, which only saves retries.
  The mutex in `src/lib/data.ts` is not used and is not relied on for anything across processes.
- **Readers** see only whole records, because a record appears under its final name only after it has been written and fsynced.

## Crash behaviour

`tests/production-store.test.ts` simulates a crash at every file-system call of create, edit, undo, label, begin-run and discard-run, with and without a torn temporary write.
From the failing call onwards every call fails, as if the process had stopped.
There are 72 crash points in all (144 trials with the torn-write variant), and each reopens to exactly the previous state or the new one, after which the store keeps working.

Durability across power loss depends on the file system and the disk honouring `fsync`, which has not been measured.
The store claims crash consistency for process crashes, which the tests verify. It does not claim power-loss durability.

## Damage and unsupported versions

- An unreadable, structurally invalid or misplaced record, a missing document, or a document that fails admission or does not match its hash is reported as `corrupt`.
- A record or document from a newer CreatorBrio is reported as `unsupported_version`.
- File-system failures are reported as `io_error` with the operation and error code.
- None of these is replaced by a default or an older state.
  Writes are refused while the current state cannot be read, and listing reports a damaged production without failing the others.
- `recover(id, { fromGeneration })` is an explicit decision to continue from an earlier, intact generation.
  It commits that state as a new generation, copies the damaged record and documents to `quarantine/`, and leaves the damaged record in the journal.
  It is refused while the current state is readable, and for an `unsupported_version` record, so data written by a newer version is never hidden.

## Agent runs across a restart

An open run records its owner: the store instance that began it, with the process id and host.
Another store instance, for example after a restart, reports `recoveryRequired`, including whether the owning process is still alive on this host.
It refuses every change with `recovery_required` until a person calls `resolveInterruptedRun` with `keep`, `discard` or `resume`.
A run is therefore never kept, discarded or continued automatically, and its edits stay marked as part of an unfinished run.
If the original owner tries to continue after someone else ended its run, the engine answers `no_open_run`.

## Disk use

Every 16 generations the store deletes journal records outside the newest 64.
It also deletes documents and temporary files that no retained record names and that are older than ten minutes.
Writing a document that already exists refreshes its modification time, so collection does not remove a document a slow writer is about to reference.
If any retained record cannot be read, collection leaves documents alone.

## Limits

- Hard links are required. File systems without them, such as FAT or exFAT volumes, answer `io_error`, and nothing is written.
- Ownership of a run is decided by process id on one host; on another host the owner's state is reported as unknown.
- Collection's ten-minute grace period assumes no writer pauses longer than that between writing a document and committing its record.
