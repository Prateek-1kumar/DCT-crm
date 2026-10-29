import { describe, expect, it } from "vitest";
import { blankNumbers } from "../src";

describe("blankNumbers: a note never gives a withheld value away", () => {
  it.each([
    // amounts
    ["Should be $104, see the amendment page", "Should be $•••, see the amendment page"],
    ["$1,245.20", "$•••"],
    ["1,245.20 not 1,254.20", "••• not •••"],
    ["USD 1,000 or USD1000 or net45 or Net-30", "USD ••• or USD••• or net••• or Net-•••"],
    ["-$5.00 off", "-$••• off"],
    // percentages, counts and durations
    ["10%", "•••%"],
    ["overhead is 10 percent", "overhead is ••• percent"],
    ["45 days", "••• days"],
    ["paid within forty-five (45) days", "paid within ••• (•••) days"],
    ["one hundred and twenty days", "••• days"],
    ["up to 3 per randomized subject", "up to ••• per randomized subject"],
    ["the 30th day, 2x, 45days", "the •••th day, •••x, •••days"],
    ["Day 45 and Month 6 are values", "Day ••• and Month ••• are values"],
    // dates, whole
    ["applies from 2026-09-01", "applies from •••"],
    ["from 09/01/2026 or 1.9.26", "from ••• or •••"],
    ["Sept. 1, 2026", "•••"],
    ["1 September 2026 and the 15th of March", "••• and the •••"],
    ["from September, in Q4 2026, FY2026", "from •••, in •••, •••"],
    ["Sponsor may pay; ask Jan", "Sponsor may pay; ask Jan"],
    ["May 5", "•••"],
    // kept: where to look, and codes
    ["V2", "V2"],
    ["Visit V2 and v10, SC003", "Visit V2 and v10, SC003"],
    ["protocol NWP-418-02 and HAL-2207", "protocol NWP-418-02 and HAL-2207"],
    ["see page 4, p. 9, pp. 3–5 and §4.2(b)", "see page 4, p. 9, pp. 3–5 and §4.2(b)"],
    ["Section 4.2.1 of Exhibit A, Attachment 2, Amendment No. 1", "Section 4.2.1 of Exhibit A, Attachment 2, Amendment No. 1"],
    ["row 12, column V2, Week 4 visit, Visit 3, CPT 99213", "row 12, column V2, Week 4 visit, Visit 3, CPT 99213"],
    // …but not a quantity dressed as a place
    ["page 30 days", "page ••• days"],
    ["line 1,245.00", "line •••"],
    ["page 4 of 9", "page 4 of •••"],
    ["up-to-45 and approx45 and Covid-19", "up-to-••• and approx••• and Covid-•••"],
    ["Blood draw (36415) should be 25", "Blood draw (•••) should be •••"],
    // nothing to blank
    ["Looks wrong, check the amendment", "Looks wrong, check the amendment"],
    ["", ""],
    // "one" as a word stays; as a number it goes
    ["No one checked this", "No one checked this"],
    ["Exhibit A and Attachment 2 price the same visits and disagree. Which one should we bill from?", "Exhibit A and Attachment 2 price the same visits and disagree. Which one should we bill from?"],
    ["one of the visits, this one, someone, none, a one-time fee", "one of the visits, this one, someone, none, a one-time fee"],
    ["one (1) screen failure per one (1) randomized subject", "••• (•••) screen failure per ••• (•••) randomized subject"],
    ["one per randomized subject, within one day, one hundred and one dollars", "••• per randomized subject, within ••• day, ••• dollars"],
    ["twenty-one days, ten (10) visits, forty-five days", "••• days, ••• (•••) visits, ••• days"],
  ])("%j → %j", (note, shown) => expect(blankNumbers(note)).toBe(shown));

  it("leaves no digit of an amount, percentage, count or date", () => {
    const leaks = "Pay $8,489.00 (eight thousand) at 12.5% within 30 days from 2026-01-15, 6 months after close, cap 4";
    expect(blankNumbers(leaks)).not.toMatch(/\d|eight|thousand/i);
  });
});
