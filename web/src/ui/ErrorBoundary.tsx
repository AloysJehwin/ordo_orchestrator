import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Catches a crash in the part of the page below it and shows what went wrong with a way out, instead of a blank page.
 * Keyed by the route where it is used, so moving to another page starts fresh.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; where?: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ordo] ${this.props.where ?? "page"} crashed`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="card stack" role="alert" style={{ maxWidth: 640, margin: "32px auto" }}>
        <h2>This {this.props.where ?? "page"} could not be shown</h2>
        <p className="muted small">Something on it failed to load. The details are in the browser console; nothing was changed.</p>
        <p className="mono small faint">{error.message}</p>
        <div className="row">
          <button className="btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button className="btn ghost" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
