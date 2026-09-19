export class NotificationError extends Error {
  constructor(readonly code: "NOT_FOUND" | "INVALID_REQUEST" | "INVALID_TARGET" | "STORAGE_FAILURE") {
    super({ NOT_FOUND: "This notification is no longer available.", INVALID_REQUEST: "Check the notification request.",
      INVALID_TARGET: "This action is no longer needed. Refresh to see its current state.",
      STORAGE_FAILURE: "Notifications could not be updated. Please try again." }[code]);
    this.name = "NotificationError";
  }
}
