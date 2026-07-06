import React, { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error?: Error }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("MCLP UI error boundary caught:", error, info);
  }

  private reset = () => {
    // Full reload is the safest reset for a complex wizard + in-flight jobs
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#e8edf0",
          padding: 24,
          fontFamily: "Inter, system-ui, sans-serif"
        }}>
          <div style={{
            background: "white",
            borderRadius: 12,
            padding: 32,
            maxWidth: 520,
            boxShadow: "0 20px 50px rgba(20,36,44,0.12)",
            textAlign: "center"
          }}>
            <h2 style={{ margin: "0 0 12px", color: "#b94a48" }}>Algo deu errado na interface</h2>
            <p style={{ margin: "0 0 20px", color: "#475569", lineHeight: 1.5 }}>
              Ocorreu um erro inesperado ao renderizar o assistente. Isso pode acontecer após um erro de rede ou dados inesperados do backend.
            </p>
            <button
              onClick={this.reset}
              style={{
                background: "#176b52",
                color: "white",
                border: "none",
                borderRadius: 8,
                padding: "10px 20px",
                fontWeight: 700,
                cursor: "pointer"
              }}
            >
              Recarregar a página
            </button>
            {this.state.error && (
              <pre style={{
                marginTop: 20,
                fontSize: 11,
                textAlign: "left",
                background: "#f8fafc",
                padding: 12,
                borderRadius: 6,
                color: "#334155",
                overflow: "auto"
              }}>
                {this.state.error.message}
              </pre>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
