import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ComponentType<{error: Error | null}>;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error);
    console.error('Error info:', errorInfo);
    
    this.setState({
      error,
      errorInfo,
    });
  }

  handleRetry = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  }

  render() {
    if (this.state.hasError) {
      // Se um fallback personalizado foi fornecido, use-o
      if (this.props.fallback) {
        const FallbackComponent = this.props.fallback;
        return <FallbackComponent error={this.state.error} />;
      }

      // Fallback padrão
      return (
        <div 
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            backgroundColor: '#1e2028',
            color: '#e6edf3',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            padding: '20px',
          }}
        >
          <div 
            style={{
              backgroundColor: '#383b42',
              padding: '24px',
              borderRadius: '8px',
              border: '1px solid #3c3c3c',
              maxWidth: '600px',
              width: '100%',
            }}
          >
            <h1 
              style={{
                color: '#ff5555',
                fontSize: '24px',
                marginBottom: '16px',
                fontWeight: 'bold',
              }}
            >
              🚨 Erro no TM Code
            </h1>
            
            <p style={{ marginBottom: '16px', color: '#cccccc' }}>
              Algo deu errado na aplicação. Por favor, veja os detalhes abaixo:
            </p>
            
            {this.state.error && (
              <div 
                style={{
                  backgroundColor: '#2b2d33',
                  padding: '12px',
                  borderRadius: '4px',
                  border: '1px solid #ff5555',
                  marginBottom: '16px',
                  fontFamily: 'monospace',
                  fontSize: '14px',
                  color: '#ff79c6',
                  overflowX: 'auto',
                }}
              >
                <strong>Erro:</strong> {this.state.error.message}
              </div>
            )}
            
            {this.state.errorInfo && (
              <details style={{ marginBottom: '16px' }}>
                <summary style={{ color: '#8be9fd', cursor: 'pointer' }}>
                  Stack trace (clique para expandir)
                </summary>
                <pre 
                  style={{
                    backgroundColor: '#2b2d33',
                    padding: '12px',
                    borderRadius: '4px',
                    border: '1px solid #3c3c3c',
                    marginTop: '8px',
                    fontSize: '12px',
                    color: '#999999',
                    overflowX: 'auto',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {this.state.errorInfo.componentStack}
                </pre>
              </details>
            )}
            
            <div style={{ display: 'flex', gap: '12px' }}>
              <button
                onClick={this.handleRetry}
                style={{
                  backgroundColor: '#007acc',
                  color: 'white',
                  border: 'none',
                  padding: '12px 24px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: 'bold',
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.backgroundColor = '#094771';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.backgroundColor = '#007acc';
                }}
              >
                🔄 Tentar Novamente
              </button>
              
              <button
                onClick={() => window.location.reload()}
                style={{
                  backgroundColor: '#383b42',
                  color: '#cccccc',
                  border: '1px solid #3c3c3c',
                  padding: '12px 24px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.backgroundColor = '#4b4b4d';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.backgroundColor = '#2d2d30';
                }}
              >
                🔄 Recarregar Página
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}