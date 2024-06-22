import React from 'react';

interface BrandProps {
  /** Use the white variant on dark surfaces. */
  light?: boolean;
  /** Tailwind size class for the mark; the wordmark scales with it. */
  className?: string;
}

/**
 * The product brand: mark + wordmark.
 *
 * The mark is a logoipsum logogram - a watchful eye. Two files ship with the
 * app (`/logo.svg` slate, `/logo-dark.svg` white) so the same mark works on
 * the light pages and on the dark instrument panel of the auth screen.
 */
export const Brand: React.FC<BrandProps> = ({ light = false, className = 'h-5' }) => (
  <span className="flex items-center gap-2">
    <img src={light ? '/logo-dark.svg' : '/logo.svg'} alt="" aria-hidden className={className} />
    <span
      className={`text-[15px] font-semibold tracking-tight ${light ? 'text-white' : 'text-zinc-950'}`}
    >
      Vigil
    </span>
  </span>
);
