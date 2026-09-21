export type Section<T> = { data: T; error?: never } | { data?: never; error: string };
export type DashboardMetrics = {
  date: string; today: string; weekStart: string; timeZone: string; takenAt: string;
  sections: {
    enrollment: Section<{ count: number }>;
    attendance: Section<{ count: number | null; reviewRequired: boolean }>;
    staff: Section<{ count: number }>;
    inventory: Section<{ total: number; low: number; out: number }>;
    meals: Section<{ savedAt: string | null; items: { slot: string; label: string; name: string }[] }>;
    activities: Section<{ rooms: {
      id: string; name: string; active: boolean; savedAt: string | null;
      entries: { id: string; name: string; startTime: string | null; endTime: string | null; timeBlock: string | null }[];
    }[] }>;
    changes: Section<{ id: string; label: string; href: string; occurredAt: string }[]>;
  };
};
