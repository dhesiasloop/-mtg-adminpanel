import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/auth';
import Layout from './components/layout/Layout';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Register from './pages/Register';
import VerifyEmail from './pages/VerifyEmail';
import ResetPassword from './pages/ResetPassword';
import Dashboard from './pages/Dashboard';
import Proxies from './pages/Proxies';
import ProxyDetail from './pages/ProxyDetail';
import Payments from './pages/Payments';
import Profile from './pages/Profile';
import Plans from './pages/Plans';
import Offer from './pages/Offer';
import Privacy from './pages/Privacy';
import PaymentResult from './pages/PaymentResult';
import Changelog from './pages/Changelog';
import { ToastProvider } from './components/ui/Toast';

function PrivateRoute({ children }) {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated);
  return isAuthenticated ? children : <Navigate to="/login" />;
}

function GuestRoute({ children }) {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated);
  return !isAuthenticated ? children : <Navigate to="/dashboard" />;
}

export default function App() {
  return (
    <ToastProvider>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<GuestRoute><Login /></GuestRoute>} />
        <Route path="/register" element={<GuestRoute><Register /></GuestRoute>} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/verify-link-email" element={<VerifyEmail type="link" />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/offer" element={<Offer />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/changelog" element={<Changelog />} />

        <Route element={<PrivateRoute><Layout /></PrivateRoute>}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/plans" element={<Plans />} />
          <Route path="/proxies" element={<Proxies />} />
          <Route path="/proxies/:orderId" element={<ProxyDetail />} />
          <Route path="/payments" element={<Payments />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/updates" element={<Changelog />} />
        </Route>

        <Route path="/payment/result" element={<PaymentResult />} />

        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </BrowserRouter>
    </ToastProvider>
  );
}
