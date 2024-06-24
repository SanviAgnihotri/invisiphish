import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuthBaseUrl } from '@/lib/auth/useAuthBaseUrl';
import { AuthLayout } from '@/pages/auth/AuthLayout';
import { GoogleButton } from '@/pages/auth/GoogleButton';

export const Register: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    organization: ''
  });

  // The Auth service's address is known at build time, so the Google button
  // is drawn in the first paint instead of arriving a moment later.
  const authBaseUrl = useAuthBaseUrl();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      await api.signUp(
        formData.email,
        formData.password,
        formData.name,
        formData.organization,
      );

      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout title="Create your Vigil account" subtitle="Explainable phishing detection, four modules deep.">
      {error && (
        <div className="error-banner mb-4">
          <span className="break-words">{error}</span>
        </div>
      )}

      {authBaseUrl && (
        <GoogleButton
          authBaseUrl={authBaseUrl}
          label="Sign up with Google"
          divider="or"
        />
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="name" className="form-label">
            Name
          </label>
          <input
            id="name"
            type="text"
            required
            autoComplete="name"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            className="form-input"
            placeholder="Ada Lovelace"
          />
        </div>

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

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="organization" className="form-label">
              Organization
            </label>
            <input
              id="organization"
              type="text"
              value={formData.organization}
              onChange={(e) => setFormData({ ...formData, organization: e.target.value })}
              className="form-input"
              placeholder="Optional"
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
              autoComplete="new-password"
              value={formData.password}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              className="form-input"
              placeholder="••••••••"
            />
          </div>
        </div>

        <button type="submit" disabled={loading} className="btn-primary w-full">
          {loading ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="mt-4 text-center text-sm text-zinc-500">
        Already registered?{' '}
        <Link
          to="/login"
          className="font-medium text-zinc-900 underline-offset-2 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
};
