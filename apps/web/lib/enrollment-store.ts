import { S3Client, write } from "bun";

import type { PythonAdminIdentityFile } from "./protocol";

export interface EnrollmentMetadata {
  color: string;
  email?: string;
  githubUsername?: string;
  linkedinId?: string;
  name: string;
  phoneNumber?: string;
  worksAt?: string;
}

export interface EnrollmentManifestIdentity {
  files: string[];
  id: string;
  metadata: EnrollmentMetadata;
}

interface EnrollmentManifest {
  identities: EnrollmentManifestIdentity[];
}

interface EnrollmentStoreConfig {
  bucket: string;
  client: S3Client;
}

const MANIFEST_KEY = "manifest.json";

const createClient = (): EnrollmentStoreConfig | null => {
  const bucket = Bun.env["MAYA_R2_BUCKET"];
  const endpoint = Bun.env["MAYA_R2_ENDPOINT"];
  const accessKeyId = Bun.env["MAYA_R2_ACCESS_KEY_ID"];
  const secretAccessKey = Bun.env["MAYA_R2_SECRET_ACCESS_KEY"];

  if (
    bucket === undefined ||
    endpoint === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined
  ) {
    return null;
  }

  return {
    bucket,
    client: new S3Client({
      accessKeyId,
      bucket,
      endpoint,
      region: "auto",
      secretAccessKey,
    }),
  };
};

const storeConfig = createClient();

const getStoreConfig = (): EnrollmentStoreConfig => {
  if (storeConfig === null) {
    throw new Error("R2 enrollment storage is not configured.");
  }
  return storeConfig;
};

const sortManifest = (manifest: EnrollmentManifest): EnrollmentManifest => ({
  identities: manifest.identities.toSorted((left, right) =>
    left.id.localeCompare(right.id)
  ),
});

const fileFor = (key: string) => getStoreConfig().client.file(key);

export const isEnrollmentStoreConfigured = (): boolean => storeConfig !== null;

export const readManifest = async (): Promise<EnrollmentManifest> => {
  try {
    const text = await fileFor(MANIFEST_KEY).text();
    if (!text) {
      return { identities: [] };
    }
    return sortManifest(JSON.parse(text) as EnrollmentManifest);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("404") ||
        error.message.includes("The specified key does not exist"))
    ) {
      return { identities: [] };
    }
    throw error;
  }
};

const writeManifest = async (manifest: EnrollmentManifest): Promise<void> => {
  await write(fileFor(MANIFEST_KEY), JSON.stringify(sortManifest(manifest)));
};

const deleteKeys = async (keys: string[]): Promise<void> => {
  for (const key of keys) {
    await fileFor(key).delete();
  }
};

const normalizeMetadata = (
  metadata: EnrollmentMetadata
): EnrollmentMetadata => ({
  color: metadata.color,
  ...(metadata.email === undefined ? {} : { email: metadata.email }),
  ...(metadata.githubUsername === undefined
    ? {}
    : { githubUsername: metadata.githubUsername }),
  ...(metadata.linkedinId === undefined
    ? {}
    : { linkedinId: metadata.linkedinId }),
  name: metadata.name,
  ...(metadata.phoneNumber === undefined
    ? {}
    : { phoneNumber: metadata.phoneNumber }),
  ...(metadata.worksAt === undefined ? {} : { worksAt: metadata.worksAt }),
});

export const listEnrollmentIdentities = async (): Promise<
  EnrollmentManifestIdentity[]
> => {
  const manifest = await readManifest();
  return manifest.identities;
};

export const readEnrollmentIdentityFiles = (
  identity: EnrollmentManifestIdentity
): Promise<PythonAdminIdentityFile[]> =>
  Promise.all(
    identity.files.map(async (filename) => ({
      data: Buffer.from(
        await fileFor(`${identity.id}/${filename}`).arrayBuffer()
      ).toString("base64"),
      name: filename,
    }))
  );

export const upsertEnrollmentIdentity = async (
  metadata: EnrollmentMetadata & { id: string },
  files: File[]
): Promise<EnrollmentManifestIdentity[]> => {
  const manifest = await readManifest();
  const existing = manifest.identities.find(
    (identity) => identity.id === metadata.id
  );
  const nextFiles = files.map((file) => file.name);
  const staleFiles =
    existing?.files.filter((filename) => !nextFiles.includes(filename)) ?? [];

  await Promise.all(
    files.map(async (file) => {
      await write(fileFor(`${metadata.id}/${file.name}`), file);
    })
  );

  await write(
    fileFor(`${metadata.id}/metadata.json`),
    JSON.stringify(normalizeMetadata(metadata))
  );

  if (staleFiles.length > 0) {
    await deleteKeys(
      staleFiles.map((filename) => `${metadata.id}/${filename}`)
    );
  }

  const nextIdentity: EnrollmentManifestIdentity = {
    files: nextFiles,
    id: metadata.id,
    metadata: normalizeMetadata(metadata),
  };

  const identities = manifest.identities.filter(
    (identity) => identity.id !== metadata.id
  );
  identities.push(nextIdentity);
  await writeManifest({ identities });
  return listEnrollmentIdentities();
};

export const deleteEnrollmentIdentity = async (
  identityId: string
): Promise<EnrollmentManifestIdentity[]> => {
  const manifest = await readManifest();
  const existing = manifest.identities.find(
    (identity) => identity.id === identityId
  );
  if (existing === undefined) {
    return manifest.identities;
  }

  await deleteKeys([
    `${identityId}/metadata.json`,
    ...existing.files.map((filename) => `${identityId}/${filename}`),
  ]);

  const identities = manifest.identities.filter(
    (identity) => identity.id !== identityId
  );
  await writeManifest({ identities });
  return listEnrollmentIdentities();
};
