import React from 'react';
import { Navigate } from 'react-router-dom';
import { useCurrentUser } from '@/lib/auth/session';

interface PublicRouteProps {
  children: React.ReactNode;
}

/**
 * The other half of the route guard.
 *
 * A visitor who already holds a session has no business on the sign-in page:
 * they are sent straight to the dashboard. The form is painted first, though,
 * and the check runs beside it - a public page that waits on a session lookup
 * shows a spinner for a form the visitor may well be about to use.
 */
export const PublicRoute: React.FC<PublicRouteProps> = ({ children }) => {
  const { user } = useCurrentUser();

  if (user) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
};
