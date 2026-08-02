import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import DashboardPage from './pages/DashboardPage'
import OperationsPage from './pages/OperationsPage'
import InfoPage from './pages/InfoPage'
import BalanceSheetPage from './pages/BalanceSheetPage'
import HealthPage from './pages/HealthPage'
import BankStatementPage from './pages/BankStatementPage'
import DocumentsPage from './pages/DocumentsPage'
import BudgetPage from './pages/BudgetPage'
import PaymentCalendarPage from './pages/PaymentCalendarPage'
import ClassificationRulesPage from './pages/ClassificationRulesPage'
import AcquiringFeeRulesPage from './pages/AcquiringFeeRulesPage'
import ProjectsPage from './pages/ProjectsPage'
import BalanceItemsPage from './pages/BalanceItemsPage'
import EditLockDatePage from './pages/EditLockDatePage'
import FundPlanningPage from './pages/FundPlanningPage'
import FundSchemesPage from './pages/FundSchemesPage'

function PrivateRoute({ children }) {
  const token = localStorage.getItem('token')
  return token ? children : <Navigate to="/login" />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login"                element={<LoginPage />} />
        <Route path="/register"             element={<RegisterPage />} />
        <Route path="/dashboard"            element={<PrivateRoute><DashboardPage /></PrivateRoute>} />
        <Route path="/operations"           element={<PrivateRoute><OperationsPage /></PrivateRoute>} />
        <Route path="/info"                 element={<PrivateRoute><InfoPage /></PrivateRoute>} />
        <Route path="/balance-sheet"        element={<PrivateRoute><BalanceSheetPage /></PrivateRoute>} />
        <Route path="/bank-statement"       element={<PrivateRoute><BankStatementPage /></PrivateRoute>} />
        <Route path="/documents"            element={<PrivateRoute><DocumentsPage /></PrivateRoute>} />
        <Route path="/budget"               element={<PrivateRoute><BudgetPage /></PrivateRoute>} />
        <Route path="/payment-calendar"     element={<PrivateRoute><PaymentCalendarPage /></PrivateRoute>} />
        <Route path="/classification-rules" element={<PrivateRoute><ClassificationRulesPage /></PrivateRoute>} />
        <Route path="/health"               element={<HealthPage />} />
        <Route path="/"                     element={<Navigate to="/dashboard" />} />
        <Route path="/acquiring-fee-rules"  element={<PrivateRoute><AcquiringFeeRulesPage /></PrivateRoute>} />
        <Route path="/projects"             element={<PrivateRoute><ProjectsPage /></PrivateRoute>} />
        <Route path="/balance-items"        element={<PrivateRoute><BalanceItemsPage /></PrivateRoute>} />
        <Route path="/edit-lock-date"       element={<PrivateRoute><EditLockDatePage /></PrivateRoute>} />
        <Route path="/fund-planning"        element={<PrivateRoute><FundPlanningPage /></PrivateRoute>} />
        <Route path="/fund-schemes"         element={<PrivateRoute><FundSchemesPage /></PrivateRoute>} />
      </Routes>
    </BrowserRouter>
  )
}
