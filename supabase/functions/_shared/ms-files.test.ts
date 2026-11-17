import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { assertValidName, createFolder, deleteItem, FOLDER_MIME, odataQuote, resolveDriveId, toDriveFile } from "./ms-files.ts";

const res = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status });

Deno.test("maps folders and files to Drive-shaped objects", () => {
  assertEquals(toDriveFile({ id: "1", name: "a", folder: {} }).mimeType, FOLDER_MIME);
  const f = toDriveFile({ id: "2", name: "b.pdf", size: 5, file: { mimeType: "application/pdf" }, parentReference: { id: "p" } });
  assertEquals([f.mimeType, f.size, f.parents], ["application/pdf", "5", ["p"]]);
});

Deno.test("name validation and odata quoting", () => {
  assertEquals(assertValidName("  Client A "), "Client A");
  for (const bad of ["", "a/b", "a:b", "trail.", "..", "x".repeat(256)]) {
    let threw = false;
    try { assertValidName(bad); } catch { threw = true; }
    assertEquals(threw, true, bad);
  }
  assertEquals(odataQuote("O'Brien"), "O''Brien");
});

Deno.test("drive id: explicit id wins, else site lookup, else the user's OneDrive", async () => {
  const env = (m: Record<string, string>) => ({ get: (k: string) => m[k] });
  assertEquals(await resolveDriveId("t", env({ MS_SHAREPOINT_DRIVE_ID: "D1" })), "D1");
  // site configured -> resolve the shared library
  const site = ((u: string) => Promise.resolve(res({ id: u.includes("/sites/") ? "D2" : "WRONG" }))) as unknown as typeof fetch;
  assertEquals(await resolveDriveId("t", env({ MS_SHAREPOINT_SITE: "h:/sites/Office" }), site), "D2");
  // nothing configured -> fall back to /me/drive
  const me = ((u: string) => Promise.resolve(res({ id: u.includes("/me/drive") ? "ONEDRIVE" : "WRONG" }))) as unknown as typeof fetch;
  assertEquals(await resolveDriveId("t", env({}), me), "ONEDRIVE");
});

Deno.test("createFolder is idempotent on 409 and rejects non-folder clashes", async () => {
  let n = 0;
  const f = ((_u: string) => Promise.resolve(++n === 1 ? res({}, 409) : res({ value: [{ id: "F", name: "X", folder: {} }] }))) as unknown as typeof fetch;
  assertEquals((await createFolder("t", "d", "X", "root", f)).id, "F");
  n = 0;
  const g = ((_u: string) => Promise.resolve(++n === 1 ? res({}, 409) : res({ value: [{ id: "N", name: "X", file: {} }] }))) as unknown as typeof fetch;
  await assertRejects(() => createFolder("t", "d", "X", "root", g), Error, "non-folder");
});

Deno.test("refuses to delete the library root", async () => {
  await assertRejects(() => deleteItem("t", "d", "root"), Error, "root");
});
