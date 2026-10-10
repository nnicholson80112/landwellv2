// One place for the brand. "Landwell" is a working name: run a trademark
// search before using it publicly, then change it here and in apps/site.
export const BRAND = {
  name: 'Landwell',
  tagline: 'Your rentals, handled. You just approve.',
  supportEmail: 'help@landwell.example',
  colors: {
    background: '#F6F9FF', // airy sky white
    surface: '#FFFFFF',
    ink: '#0E1B33', // navy text
    primary: '#1B4DFF', // Landwell blue: main buttons and links
    sun: '#FFC83D', // highlights and secondary buttons
    mint: '#0E9F6E', // success
    coral: '#C2410C', // attention
  },
  fonts: { display: 'Bricolage Grotesque', body: 'Figtree' },
} as const;
