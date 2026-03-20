import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import DashboardPage from './pages/DashboardPage'
import InfoPage from './pages/InfoPage'
import BalanceSheetPage from './pages/BalanceSheetPage'
import HealthPage from './pages/HealthPage'
import BankStatementPage from './pages/BankStatementPage'
import DocumentsPage from './pages/DocumentsPage'

function PrivateRoute({ children }) {
  const token = localStorage.getItem('token')
  return token ? children : <Navigate to="/login" />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login"           element={<LoginPage />} />
        <Route path="/register"        element={<RegisterPage />} />
        <Route path="/dashboard"       element={<PrivateRoute><DashboardPage /></PrivateRoute>} />
        <Route path="/info"            element={<PrivateRoute><InfoPage /></PrivateRoute>} />
        <Route path="/balance-sheet"   element={<PrivateRoute><BalanceSheetPage /></PrivateRoute>} />
        <Route path="/bank-statement"  element={<PrivateRoute><BankStatementPage /></PrivateRoute>} />
        <Route path="/documents"       element={<PrivateRoute><DocumentsPage /></PrivateRoute>} />
        <Route path="/health"          element={<HealthPage />} />
        <Route path="/"                element={<Navigate to="/dashboard" />} />
      </Routes>
    </BrowserRouter>
  )
}
