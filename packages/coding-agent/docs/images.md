# Image inputs and original attachments

Pi keeps **local originals**, **prepared model images**, and **request evidence** separate. A smaller image or a successful HTTP response does not prove that a model received or understood the image.

## Attach and inspect

Use the existing clipboard paste, explicit image path, `@file`, RPC `images`, or SDK image inputs. Editor `[Image #N]` markers still refer to the editor's attachments; they are not persistent source IDs or request-selection IDs.

Interactive commands:

| Command | Behavior |
| --- | --- |
| `/images` | Show local evidence, sizes, omission reasons, and request-selection IDs |
| `/images sources` | List original attachments on the active branch, deduplicated by source SHA-256; no bytes or paths |
| `/images source <sourceId>` | Read and preview an original locally; accepts a unique lowercase hex prefix of at least 8 characters |
| `/images omit <image_ID> ...` | Confirm replacement of the branch's historical request-image exclusions |
| `/images reset` | Clear those exclusions |

The source preview reuses the terminal tool-image renderer but is **not a tool execution, saved message, or provider request**. Only the latest preview is retained; rebuilding the transcript clears it. Actual image display depends on terminal image support and `terminal.showImages`. Kitty may require a local PNG display conversion. No default application is opened. An unsupported terminal can show the metadata fallback; an RPC client can explicitly retrieve the original bytes.

Source IDs are 64-character SHA-256 digests of the original bytes. A digest alone grants no access: reads require a source attachment on the active branch and successful session-store ownership/integrity checks. Inventory listing does not verify all source bytes. Missing/corrupt assets are reported when read, not silently replaced with the prepared image. The same source used with different preparations is listed once, with dimensions from its first branch occurrence. Known image-bearing content in branch-visible compaction replacement history is included, even when no separate image message exists. Arbitrary extension `details`, tool arguments, recovery strings and custom state are not searched for attachments.

## Reading the report

| Stage | Evidence |
| --- | --- |
| `accepted` | Received/accepted locally; not proof of processing or sending |
| `prepared` | Local validation/preparation completed |
| `serialized` | A supported provider payload's image shape was checked locally |
| `omitted` | Image absent from the temporary request view, with a reason |

**Remote image receipt remains UNVERIFIED.** These reports do not assert remote decoding or visual recognition. Custom stream implementations that bypass the payload callback are outside the final wire-guard guarantee; an SDK-managed transport's checked payload is not an exact measurement of the final HTTP body.

`inputBytes` is the source's binary byte count when known. `encodedBytes` is **Base64 ASCII bytes**, not binary bytes, image tokens, or full HTTP-body size. Reports may show prepared raster width/height. Source inventory dimensions distinguish original and prepared rasters; they do not establish CSS coordinates, screen coordinates or DPR. Successful resizing and format conversion do not append explanations, dimensions or coordinate-mapping instructions to editor/submitted text, tool content or provider messages. Processing facts remain in `/images`, RPC reports and source metadata; Pi does not guess capture/DPR mappings.

Only canonical request IDs of the form `image_` plus 24 lowercase hex characters are selection IDs. Canonical reports distinguish protected current-user/latest-current-turn-tool images from historical images when that fact is available. Admission/source facts and `wire:...` facts are not selectable. Source hashes, editor attachment numbers and wire paths are not interchangeable with canonical IDs.

## Budget failures and recovery

Pi does not silently discard current user images or the latest current-turn tool-image group to fit a budget. Older tool-image groups may be omitted from the temporary provider view. A protected-image budget failure happens locally; crop/remove current attachments or explicitly select historical images for exclusion, then retry. Failed tools are not automatically rerun to obtain an image.

`/images omit` changes only future requests on the current branch. It replaces the previous selection, does not delete history/originals, and is reversible with `/images reset`. Current protected images cannot be excluded; request preparation rejects that selection. Rewinding past the selection's branch anchor or switching to another session clears it. Exclusions are in-memory request state, not a persistent deletion policy.

Bad tool or historical images may be represented by stable local omission text in the provider view while the canonical execution/history facts remain. Invalid new user images are rejected before provider dispatch; interactive submission restores its image draft if that draft has not been superseded.

## Settings and limits

- `images.autoResize: true` (default): balanced preparation, normally at most 2000 × 2000 pixels and 4.5 MiB **Base64** per image. Conversion is performed as needed, not as a promise that every image becomes JPEG.
- `images.autoResize: false`: preserve valid original bytes without proactive downsampling/lossy encoding. Validation, input limits, output byte limits and request budgets still apply; impossible requests fail rather than silently reducing quality. Original-mode dimension limits are bounded by the pixel cap rather than the balanced 2000-pixel preference.
- `images.blockImages: true`: suppress outgoing images, including after payload hooks. This does not delete local originals or call another vision model.
- `terminal.showImages` affects display only, not provider sending.

Engineering defaults (not universal provider contracts):

| Limit key under `images.limits` | Default | Unit |
| --- | --- | --- |
| `maxInputBytes` | 20971520 | Binary bytes per source (20 MiB) |
| `maxBatchInputBytes` | 33554432 | Binary bytes per admitted batch (32 MiB) |
| `maxInputPixels` | 32000000 | Decoded source pixels |
| `maxImages` | 32 | Images per batch/request |
| `maxEncodedBytes` | 4718592 | Base64 ASCII bytes per output image (4.5 MiB) |
| `maxRequestEncodedBytes` | 25165824 | Inline image Base64 bytes per request (24 MiB) |
| `maxWidth`, `maxHeight` | 2000 each in balanced mode | Output raster pixels |
| `timeoutMs` | 10000 | Per-image processing milliseconds, including queue time |
| `batchTimeoutMs` | 30000 | Batch preparation milliseconds |

Overrides must be positive safe integers and can only tighten the applicable engineering defaults. Route-specific SDK constraints match the authentication-resolved API/endpoint rather than guessed model names:

```typescript
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  imagePolicyOverrides: [{
    api: "openai-completions",
    baseUrl: "https://gateway.example/v1",
    limits: { maxImages: 4 },
    source: "operator",
  }],
});
```

This example constrains only requests whose **actual**, authentication-resolved API/endpoint matches that route. It does not discover or verify the gateway's capabilities. See [Settings](settings.md#terminal--images). These limits reduce resource risk; they are not hard process-RSS guarantees or measured image-quality guarantees.

## Storage, portability, and privacy

New persistent v4 sessions store original and prepared bytes separately in `<session.jsonl>.images/`, with session-owned content-addressed assets. Existing v1–v3 sessions remain inline and are not automatically converted to v4; they do not gain durable originals. In-memory sessions retain originals in a bounded session-local map (32 sources / 32 MiB), with explicit reads available while the session lives and no filesystem path.

A pre-session CLI/source handoff is bounded to 32 entries / 32 MiB and can expire; if its original snapshot is no longer available, reattach the original. Reusing a prepared image object across sessions can explicitly fail with `storage_missing` rather than falsely treating prepared bytes as original provenance.

On load, derivative-only loss recovers a separately verified original with an explicit local notice. Original-only loss keeps a usable prepared image with an original-unavailable notice, without relabeling that prepared image as an original. If neither is usable, the image becomes local omission text. These are local recovery facts, not remote receipt evidence.

For backups of native v4 sessions, keep the JSONL **and** its image directory together. Fork/clone copy needed assets into the new session's ownership scope. Portable JSONL/HTML export includes inline prepared images, strips app-only source references, and does **not** bundle originals. Importing a portable export cannot restore original bytes that were not exported. There is no default image garbage collection; `SessionManager.auditImageAssets()` is a read-only whole-log audit, not an instruction to delete branch-inactive assets. See [Session format](session-format.md#image-storage-v4).

No automatic public upload, extra vision call, image telemetry, credential URL, or private filesystem path is added by these reports or the source viewer. RPC `get_images` returns reports (and optionally summaries), never original Base64 by default. `get_image_source` explicitly returns at most 20 MiB decoded source bytes plus MIME/dimensions. Treat that response and native image directories as private image content. See the [RPC image commands](rpc.md#get_images).
