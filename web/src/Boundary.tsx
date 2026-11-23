// A crash in one part of the page stays in that part: it's reported (Settings → Health), the
// part retries once on its own, and otherwise says plainly what happened with a retry button.
import { Component, type ReactNode } from 'react'
import { reportError } from './api'

export class Boundary extends Component<{ where: string; children: ReactNode }, { error: Error | null; retried: boolean }> {
  state = { error: null as Error | null, retried: false }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error) {
    reportError(this.props.where, error)
    if (!this.state.retried) setTimeout(() => this.setState({ error: null, retried: true }), 1500)
  }
  componentDidUpdate(prev: { where: string }) { if (prev.where !== this.props.where && this.state.error) this.setState({ error: null, retried: false }) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash">
        <b>This part of auto-m8 hit a problem.</b>
        <span className="muted small">{this.state.retried ? 'It was reported. Retry, or switch views.' : 'It was reported and is retrying…'}</span>
        <code className="small">{String(this.state.error.message).slice(0, 160)}</code>
        {this.state.retried && <button onClick={() => this.setState({ error: null })}>Retry</button>}
      </div>
    )
  }
}
