import React from 'react';
import { t } from '@/i18n';

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
            // 100% do container, nunca 100vh — ver ui/ErrorBoundary.tsx: o
            // fallback de viewport inteiro dentro de um flex parent distorcia
            // o layout e escondia o resto da UI quando um descendente crashava.
            height: '100%',
            minHeight: '160px',
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
              🚨 {t('errorBoundary.occurred')}
            </h1>
            
            <p style={{ marginBottom: '16px', color: '#cccccc' }}>
              {t('errorBoundary.contentError')}
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
                <strong>{t('errorBoundary.errorPrefix')}</strong> {this.state.error.message}
              </div>
            )}
            
            {this.state.errorInfo && (
              <details style={{ marginBottom: '16px' }}>
                <summary style={{ color: '#8be9fd', cursor: 'pointer' }}>
                  {t('errorBoundary.stackTrace')}
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
                🔄 {t('errorBoundary.tryAgain')}
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
                🔄 {t('errorBoundary.reload')}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}