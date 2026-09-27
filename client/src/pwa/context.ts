import { createContext } from 'react';

export const AppHelpContext = createContext<(() => void) | null>(null);
