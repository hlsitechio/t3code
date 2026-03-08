import { describe, expect, it } from "vitest";

import { parseUiCommandIntent } from "./uiCommandIntents";

describe("parseUiCommandIntent", () => {
  it("parses browser navigation intents", () => {
    expect(parseUiCommandIntent("navigate browser to facebook")).toEqual({
      type: "navigate-browser",
      target: "https://www.facebook.com/",
    });
  });

  it("parses browser click intents", () => {
    expect(parseUiCommandIntent("click the email field")).toEqual({
      type: "browser-act",
      action: {
        kind: "click",
        target: "email field",
      },
    });
  });

  it("parses browser type intents", () => {
    expect(parseUiCommandIntent("type hlarosesurprenant@gmail.com in the email field")).toEqual({
      type: "browser-act",
      action: {
        kind: "type",
        text: "hlarosesurprenant@gmail.com",
        target: "email field",
      },
    });
  });

  it("parses browser press intents", () => {
    expect(parseUiCommandIntent("press enter")).toEqual({
      type: "browser-act",
      action: {
        kind: "press",
        key: "Enter",
      },
    });
  });

  it("parses browser scroll intents", () => {
    expect(parseUiCommandIntent("scroll down 500")).toEqual({
      type: "browser-act",
      action: {
        kind: "scroll",
        direction: "down",
        amount: 500,
      },
    });
  });
});
