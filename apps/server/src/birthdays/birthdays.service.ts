import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { BirthdayDataAdapter } from "./birthday-data.adapter.js";
import { birthdayCalendar } from "./birthday-calendar.js";

/** Public facade: HTTP and workers depend on this API, never a particular source. */
@Injectable()
export class BirthdaysService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(BirthdayDataAdapter) private readonly data: BirthdayDataAdapter,
  ) {}
  get enabled() {
    return this.data.enabled;
  }
  async calendar(now = new Date(), summary = false) {
    const empty = birthdayCalendar([], now);
    const hidden = {
      enabled: false,
      today: empty.today,
      windowEnd: empty.windowEnd,
      timezone: "Asia/Shanghai",
      people: [],
    };
    if (!this.enabled) return hidden;
    const settings = await this.db.birthdaySettings.findUnique({
      where: { id: "global" },
    });
    if (settings?.displayEnabled === false) return hidden;
    const catalog = await this.data.catalog();
    if (!catalog) return hidden;
    const result = birthdayCalendar(catalog.people, now);
    return {
      enabled: true,
      today: result.today,
      windowEnd: result.windowEnd,
      timezone: "Asia/Shanghai",
      people: (summary ? result.summary : result.people).map(
        ({
          key,
          name,
          aliases,
          month,
          day,
          avatarUrl,
          nextDate,
          daysUntil,
        }) => ({
          key,
          name,
          aliases,
          month,
          day,
          avatarUrl,
          nextDate,
          daysUntil,
        }),
      ),
    };
  }
  async catalogStatus() {
    const catalog = this.enabled ? await this.data.catalog() : null;
    return {
      available: this.enabled,
      personCount: catalog?.people.length ?? 0,
      lastCheckedAt: catalog?.lastCheckedAt?.toISOString() ?? null,
      dataUpdatedAt: catalog?.updatedAt.toISOString() ?? null,
    };
  }
  schedule(actorId?: string, now?: Date) {
    if (!this.enabled) {
      if (actorId) throw new ConflictException("生日数据接入尚未启用");
      return Promise.resolve({ queued: false });
    }
    return this.data.schedule(actorId, now);
  }
  scheduleSupplement(now?: Date) {
    return this.enabled ? this.data.scheduleSupplement(now) : Promise.resolve();
  }
  cleanupCatalogs(now?: Date) {
    return this.enabled ? this.data.cleanupCatalogs(now) : Promise.resolve();
  }
}
