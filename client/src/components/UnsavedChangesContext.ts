import { createContext, useContext } from 'react';
export const UnsavedChangesContext = createContext<(dirty: boolean, busy: boolean) => void>(() => {});
export const useUnsavedChanges = () => useContext(UnsavedChangesContext);
