import { describe, expect, it, beforeEach } from "vitest";
import { DiffEntry, RulebookVersionDto, StudyDetailDto, StudySummaryDto } from "@dct/shared";
import { mockRequest, mockReset } from "./server";

const get = async (path: string) => (await mockRequest("GET", path, undefined)).json;
const post = (path: string, body: unknown) => mockRequest("POST", path, body);

describe("mock API", () => {
  beforeEach(() => mockReset());

  it("serves data that matches the shared schemas", async () => {
    const studies = StudySummaryDto.array().parse(await get("/studies"));
    expect(studies.length).toBeGreaterThanOrEqual(5);
    for (const s of studies) {
      const d = StudyDetailDto.parse(await get(`/studies/${s.id}`));
      for (const v of d.versions) RulebookVersionDto.parse(await get(`/studies/${s.id}/versions/${v.version}`));
    }
    DiffEntry.array().parse(await get("/studies/st-halcyon/versions/2/diff?against=1"));
  });

  it("refuses sign-off with open anomalies, allows it once all are settled", async () => {
    const res = await post("/studies/st-cobalt/versions/1/sign-off", { by: "Sam Rivera" });
    expect(res.status).toBe(409);
    const v = RulebookVersionDto.parse(await get("/studies/st-cobalt/versions/1"));
    for (const a of v.anomalies.filter((x) => !x.resolution))
      await post(`/studies/st-cobalt/versions/1/anomalies/${encodeURIComponent(a.id)}/resolve`, { kind: "accepted_with_note", note: "ok", by: "Sam Rivera" });
    expect((await post("/studies/st-cobalt/versions/1/sign-off", { by: "Sam Rivera" })).status).toBe(200);
    expect(StudyDetailDto.parse(await get("/studies/st-cobalt")).status).toBe("live");
  });

  it("amendment diff lists changed fees with readable labels", async () => {
    const diff = DiffEntry.array().parse(await get("/studies/st-halcyon/versions/2/diff?against=1"));
    expect(diff.find((e) => e.path === "/payment/netDays/value")).toMatchObject({ change: "changed", before: 45, after: 30, label: "Payment › Net days" });
    expect(diff.some((e) => e.change === "added" && e.label.includes("Remote monitoring visit"))).toBe(true);
  });
});
