import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthGuard } from './components/AuthGuard'
import { Dashboard } from './pages/Dashboard'
import { Login } from './pages/Login'

export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/dashboard"
          element={
            <AuthGuard>
              <Dashboard />
            </AuthGuard>
          }
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
