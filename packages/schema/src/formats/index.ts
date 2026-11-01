// The format checks of JSON Schema 2020-12, for compile()'s `formats` option. An optional entry point: schemas
// compiled without it treat `format` as an annotation and do not bundle these checks.

import type { FormatCheck } from "../types.ts";
import { IsDate } from "./typebox/date.ts";
import { IsDateTime } from "./typebox/date_time.ts";
import { IsDuration } from "./typebox/duration.ts";
import { IsEmail } from "./typebox/email.ts";
import { IsHostname } from "./typebox/hostname.ts";
import { IsIdnEmail } from "./typebox/idn_email.ts";
import { IsIdnHostname } from "./typebox/idn_hostname.ts";
import { IsIPv4 } from "./typebox/ipv4.ts";
import { IsIPv6 } from "./typebox/ipv6.ts";
import { IsIri } from "./typebox/iri.ts";
import { IsIriReference } from "./typebox/iri_reference.ts";
import { IsJsonPointer } from "./typebox/json_pointer.ts";
import { IsRegex } from "./typebox/regex.ts";
import { IsRelativeJsonPointer } from "./typebox/relative_json_pointer.ts";
import { IsTime } from "./typebox/time.ts";
import { IsUri } from "./typebox/uri.ts";
import { IsUriReference } from "./typebox/uri_reference.ts";
import { IsUriTemplate } from "./typebox/uri_template.ts";
import { IsUuid } from "./typebox/uuid.ts";

/** Every format JSON Schema 2020-12 defines, by name. The checks are adapted from TypeBox 1.3.27 (MIT). */
export const formats: Readonly<Record<string, FormatCheck>> = Object.freeze({
	date: IsDate,
	"date-time": IsDateTime,
	duration: IsDuration,
	email: IsEmail,
	hostname: IsHostname,
	"idn-email": IsIdnEmail,
	"idn-hostname": IsIdnHostname,
	ipv4: IsIPv4,
	ipv6: IsIPv6,
	iri: IsIri,
	"iri-reference": IsIriReference,
	"json-pointer": IsJsonPointer,
	regex: IsRegex,
	"relative-json-pointer": IsRelativeJsonPointer,
	time: IsTime,
	uri: IsUri,
	"uri-reference": IsUriReference,
	"uri-template": IsUriTemplate,
	uuid: IsUuid,
});
