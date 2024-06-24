import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuthBaseUrl } from '@/lib/auth/useAuthBaseUrl';
import { AuthLayout } from '@/pages/auth/AuthLayout';
import { GoogleButton } from '@/pages/auth/GoogleButton';

export const Login: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({
    email: '',
    password: ''
  });

  // The Auth service's address is known at build time, so the Google button
  // is drawn in the first paint instead of arriving a moment later.
  const authBaseUrl = useAuthBaseUrl();

  // The Google callback answers with a redirect, not with JSON, so a failure
  // arrives here as a query parameter.
  useEffect(() => {
    const message = searchParams.get('error');
    if (message) setError(message);
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      await api.signIn(formData.email, formData.password);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout title="Sign In to Vigil">
      {error && (
        <div className="error-banner mb-4">
          <span className="break-words">{error}</span>
        </div>
      )}

      {authBaseUrl && <GoogleButton authBaseUrl={authBaseUrl} />}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" className="form-label">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={formData.email}
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            className="form-input"
            placeholder="name@company.com"
          />
        </div>

        <div>
          <label htmlFor="password" className="form-label">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            value={formData.password}
            onChange={(e) => setFormData({ ...formData, password: e.target.value })}
            className="form-input"
            placeholder="••••••••"
          />
        </div>

        <button type="submit" disabled={loading} className="btn-primary w-full">
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="mt-4 text-center text-sm text-zinc-500">
        New here?{' '}
        <Link
          to="/register"
          className="font-medium text-zinc-900 underline-offset-2 hover:underline"
        >
          Create an account
        </Link>
      </p>
    </AuthLayout>
  );
};
