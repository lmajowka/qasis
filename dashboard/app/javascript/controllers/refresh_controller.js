import { Controller } from "@hotwired/stimulus"

// Re-reads the page every few seconds while it is visible. The layout
// refreshes with morphing, so the scroll position stays put.
export default class extends Controller {
  static values = { interval: { type: Number, default: 15 } }

  connect() {
    this.timer = setInterval(() => {
      if (document.visibilityState === "visible") Turbo.visit(location.href, { action: "replace" })
    }, this.intervalValue * 1000)
  }

  disconnect() {
    clearInterval(this.timer)
  }
}
