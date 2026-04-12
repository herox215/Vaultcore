import { describe, it, expect } from "vitest";
import { get } from "svelte/store";
import { searchStore } from "../searchStore";

describe("searchStore activeTab accepts 'tags' (TAG-03)", () => {
  it("setActiveTab('tags') updates state", () => {
    searchStore.setActiveTab("tags");
    expect(get(searchStore).activeTab).toBe("tags");
    searchStore.setActiveTab("files");
  });
});
