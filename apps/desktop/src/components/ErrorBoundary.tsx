import React from "react";

/**
 * Tiny error boundary used around panes that load asynchronous data
 * via direct catalog queries (Indexes, Info, etc.). If one throws —
 * because a server returns an unexpected shape, or a util misreads
 * a null — the whole app should NOT unmount: just the pane in
 * question shows the error message and the user can still navigate
 * to other tabs.
 */
interface State { error: Error | null }
interface Props {
  label?: string;
  children: React.ReactNode;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[error-boundary${this.props.label ? ":" + this.props.label : ""}]`, error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="placeholder" style={{ padding: 16, color: "var(--danger)" }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Something went wrong{this.props.label ? ` in ${this.props.label}` : ""}.
          </div>
          <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", color: "var(--fg-2)" }}>
            {this.state.error.message}
          </pre>
          <button className="btn-pill" style={{ marginTop: 8 }} onClick={this.reset}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
