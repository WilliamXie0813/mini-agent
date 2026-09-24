import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../src/App";

describe("App", () => {
  it("renders the top bar title", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Mini Agent" }),
    ).toBeInTheDocument();
  });
});
