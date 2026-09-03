export function success(data, warnings = []) {
    return {
        status: warnings.length > 0 ? "partial" : "success",
        collected_at: new Date().toISOString(),
        data,
        warnings,
        error: null,
    };
}
export function failure(status, code, message, warnings = []) {
    return {
        status,
        collected_at: new Date().toISOString(),
        data: null,
        warnings,
        error: { code, message },
    };
}
export function toToolResult(envelope) {
    return {
        content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
        isError: envelope.status === "error" || envelope.status === "permission_denied",
    };
}
//# sourceMappingURL=result.js.map