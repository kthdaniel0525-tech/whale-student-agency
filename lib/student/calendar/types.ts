export interface TimeWindow {
    start: string;
    end: string;
    durationMinutes: number;
}
export interface AvailabilityDay {
    date: string;
    freeWindows: TimeWindow[];
    availableMinutes: number;
}
export interface AvailabilityContext {
    status: "available" | "partial" | "unavailable" | "not-connected";
    timezone: string;
    days: AvailabilityDay[];
    checkedAt: string;
    assumptions: string[];
}
/** Domain events intentionally contain no personal title, description, or attendees. */
export interface ExternalCalendarEvent {
    externalId: string;
    calendarId: string;
    connectedAccountId: string;
    sourceProvider: string;
    start: string | null;
    end: string | null;
    allDay: boolean;
    status: "confirmed" | "tentative" | "cancelled";
    blocksTime: boolean;
}
export interface CalendarChoice {
    id: string;
    title: string;
    timezone: string;
    canWrite: boolean;
    enabledForAvailability: boolean;
    allowStudyWrites: boolean;
    blockAllDay: boolean;
}
export interface CalendarSettings {
    calendars: CalendarChoice[];
    sync: {
        status: string;
        lastSuccessfulSyncAt: string | null;
        lastErrorCode: string | null;
    } | null;
}
export interface CalendarTaskLink {
    id: string;
    connectedAccountId: string;
    calendarId: string;
    status: string;
    needsUpdate: boolean;
    openUrl: string | null;
}
export interface CalendarTaskOptions {
    timezone: string;
    scheduledStart: string | null;
    scheduledEnd: string | null;
    targets: {
        connectedAccountId: string;
        calendarId: string;
        label: string;
    }[];
    links: CalendarTaskLink[];
}
