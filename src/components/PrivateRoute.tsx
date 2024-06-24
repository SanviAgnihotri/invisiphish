import React from 'react';
import { Navigate } from 'react-router-dom';
import { useSession } from '@/lib/auth/session';

interface PrivateRouteProps {
  children: React.ReactNode;
}

export const PrivateRoute: React.FC<PrivateRouteProps> = ({ children }) => {
  const { user, loading } = useSession();

  if (loading) {
    // Show loading state while checking authentication
    return (
      <div className="flex min-h-screen items-center justify-center bg-white">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-zinc-200 border-b-zinc-900"></div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};
