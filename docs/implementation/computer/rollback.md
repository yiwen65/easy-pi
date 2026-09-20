# Computer shutdown and rollback

## Disable without changing the installation

Start without `--computer`, `--computer-manifest` or `--computer-browser`, or exclude `computer` with `--exclude-tools computer`. Ordinary coding and metadata commands remain native-inert. Tool filtering revokes authority; it does not prove already dispatched native work has stopped.

SDK embeddings must first stop new work and await session shutdown, then **await `NativeComputerFeature.close()`** at final host shutdown. A child/session close must not close the shared host. Keep the feature alive until native operation and resource terminal acknowledgements settle. Do not turn a JS timeout into a successful shutdown receipt.

## Replace an artifact

1. Stop admitting new Computer operations; revoke the session tree and request cancellation.
2. Await native terminal and host/resource close. If quarantine or unknown completion remains, stop here and preserve the installation, private browser directory, lease and logs.
3. After confirmed clean shutdown, switch the launcher to a separately hash-verified complete matching product/Computer asset directory. Do not hot-swap dylibs, generated bindings, pins or host modules independently.
4. Test the replacement with metadata/default coding first. A fresh GUI attempt needs its own permissions, target, console and conflict checks; never reuse old observation references.

The lowest-risk rollback is disabling Computer. P04/P05/P06 snapshots and patch chains are retained for engineering comparison, not drop-in replacements for the final desktop bridge. `p06-fast.patch` applies after the qualified P06 discovery sources, not bare Cua. See `native/computer/patches/README.md` in the source repository and the packaged source materials.

## Dirty lease / uncertain effects

Do not delete, truncate, reset or automatically mark the canonical desktop lease clean. Do not kill an unrelated process, infer terminality from PID disappearance, remove an unproven browser profile, or retry unknown input. Preserve operation IDs, result versus terminal records, native resource errors, exact source/asset hashes, boot/storage identity and the original dirty marker.

Administrative recovery is an explicit abandonment of an unknown old generation, **not proof of its terminality**. It needs independent diagnosis and a reviewed, authorized procedure with current ownership/storage/boot evidence, exclusive locking and durable archival before any change. The historical one-shot helpers under `.artifacts` are incident-specific and must not be used as a product recovery command. Owner56354 and historical D24/D25/D65/D70/D83 unknowns remain recorded even though later fresh qualifications succeeded.

No session history or failed evidence is removed by rollback. No automatic input replay or general recovery command is shipped.
