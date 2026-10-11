# QuickJS runtime notices

These notices accompany `quickjs-wasi` 3.6.2, including a loose `quickjs.wasm` in binary builds. They do not replace this package's own MIT `LICENSE`.

Sources pinned by the official `quickjs-wasi@3.6.2` tag:

- Wrapper: [Vercel quickjs-wasi](https://github.com/vercel-labs/quickjs-wasi/tree/5a7a0eeda87c99542f8cf3095b6d61ecfa755977), `LICENSE` → `quickjs-wasi.txt`.
- Engine: [QuickJS-NG](https://github.com/quickjs-ng/quickjs/tree/6d46d07d04041b40f4f49eaa7fdebe44c314c699), `LICENSE` → `quickjs-ng.txt`; Unicode V3 notice from `libunicode-table.h` lines 5–43 → `unicode.txt`.
- Toolchain: [wasi-sdk 32](https://github.com/WebAssembly/wasi-sdk/tree/249054e5427023344c1906afde0e9073714d1930), `LICENSE` → `wasi-sdk.txt`.
- Libc: [wasi-libc](https://github.com/WebAssembly/wasi-libc/tree/2fc32bc81b9f07f8d9525edea59bfbaf760c06d6), `LICENSE`, `LICENSE-MIT`, `libc-top-half/musl/COPYRIGHT`, and `libc-bottom-half/cloudlibc/LICENSE` → `wasi-libc.txt`, `wasi-libc-mit.txt`, `musl.txt`, and `cloudlibc.txt`.

The npm 3.6.2 wasm reports QuickJS 0.17.0. Its SHA256 is `d4c9375f2b1ca4dc95f72c8aa2982a7a9951ac8011490d79c6582df732b4bbd9`, matching the artifact in the official npm tarball. The tag's Makefile pins wasi-sdk 32 and the above engine submodule. Toolchain notices are retained conservatively; there is no published link map or build attestation proving the complete linked-component inventory. Before external binary publication, review source-specific libc/math notices or obtain the upstream runtime's complete notice bundle. No optional `.so` extension is loaded by this codemode integration.
