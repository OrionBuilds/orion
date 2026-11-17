import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { listDrives } from "./ms-files.ts";
import { personalDriveId, personalEnv, PersonalUnavailableError } from "./ms-personal-drive.ts";

const graph = ((u: string) => {
  const url = String(u);
  if (url.includes("/me/drive")) return Promise.resolve(new Response(JSON.stringify({ id: "od-1", webUrl: "https://onedrive/x" })));
  return Promise.resolve(new Response("{}", { status: 404 }));
}) as unknown as typeof fetch;

Deno.test("personal: own OneDrive is allowed (no id requested, or its own id)", async () => {
  assertEquals(await personalDriveId("t", undefined, graph), "od-1");
  assertEquals(await personalDriveId("t", "od-1", graph), "od-1");
});

Deno.test("personal: any other drive (SharePoint library) is refused with the clear message", async () => {
  const e = await assertRejects(() => personalDriveId("t", "sp-lib", graph), PersonalUnavailableError);
  assertEquals(e.message, "Not available for personal Microsoft accounts");
});

Deno.test("personal: list-drives ignores the configured SharePoint site and shows OneDrive only", async () => {
  const calls: string[] = [];
  const f = ((u: string) => { calls.push(String(u)); return graph(u, {} as never); }) as unknown as typeof fetch;
  const drives = await listDrives("t", personalEnv, f);
  assertEquals(drives.map((d) => d.kind), ["onedrive"]);
  assertEquals(calls.some((c) => c.includes("/sites/")), false);
});
