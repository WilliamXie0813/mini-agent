import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../src/App";

describe("App scaffold", () => {
  it("renders the placeholder", () => {
    render(<App />);
    expect(screen.getByText(/脚手架就绪/)).toBeInTheDocument();
  });
});
