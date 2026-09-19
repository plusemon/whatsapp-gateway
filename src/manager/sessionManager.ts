/**
 * Backward compatibility re-export of SessionService.
 */
import { sessionService, SessionService } from '../services/session.service.js';

export { sessionService, SessionService };
export const sessionManager = sessionService;
export const SessionManager = SessionService;
