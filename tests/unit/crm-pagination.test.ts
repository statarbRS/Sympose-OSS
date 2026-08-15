import { describe, expect, it } from "vitest";

import {
  CRM_PEOPLE_PAGE_SIZE,
  paginateCrmPeople,
} from "@/components/crm/pagination";

describe("CRM large-collection paging", () => {
  it("keeps every ordered person reachable while bounding each rendered page", () => {
    const people = Array.from({ length: 5_000 }, (_, index) => `person-${String(index + 1).padStart(4, "0")}`);
    const pages = Array.from({ length: 50 }, (_, index) => paginateCrmPeople(people, index + 1));

    expect(CRM_PEOPLE_PAGE_SIZE).toBe(100);
    expect(pages.every((page) => page.items.length <= CRM_PEOPLE_PAGE_SIZE)).toBe(true);
    expect(pages.flatMap((page) => page.items)).toEqual(people);
    expect(pages[0]).toMatchObject({ pageNumber: 1, pageCount: 50, firstItemNumber: 1, lastItemNumber: 100 });
    expect(pages.at(-1)).toMatchObject({ pageNumber: 50, pageCount: 50, firstItemNumber: 4_901, lastItemNumber: 5_000 });
  });

  it("clamps invalid pages and reports an empty collection without phantom rows", () => {
    expect(paginateCrmPeople(["one", "two"], 99)).toMatchObject({
      items: ["one", "two"],
      pageNumber: 1,
      pageCount: 1,
      firstItemNumber: 1,
      lastItemNumber: 2,
    });
    expect(paginateCrmPeople([], Number.NaN)).toEqual({
      items: [],
      pageNumber: 1,
      pageCount: 1,
      firstItemNumber: 0,
      lastItemNumber: 0,
      totalItems: 0,
    });
  });
});
