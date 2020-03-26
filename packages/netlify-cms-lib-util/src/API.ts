import { asyncLock, AsyncLock } from './asyncLock';
import unsentRequest from './unsentRequest';

export const CMS_BRANCH_PREFIX = 'cms';
export const DEFAULT_PR_BODY = 'Automatically generated by Netlify CMS';
export const MERGE_COMMIT_MESSAGE = 'Automatically generated. Merged on Netlify CMS.';

const NETLIFY_CMS_LABEL_PREFIX = 'netlify-cms/';
export const isCMSLabel = (label: string) => label.startsWith(NETLIFY_CMS_LABEL_PREFIX);
export const labelToStatus = (label: string) => label.substr(NETLIFY_CMS_LABEL_PREFIX.length);
export const statusToLabel = (status: string) => `${NETLIFY_CMS_LABEL_PREFIX}${status}`;

export const generateContentKey = (collectionName: string, slug: string) =>
  `${collectionName}/${slug}`;

export const parseContentKey = (contentKey: string) => {
  const index = contentKey.indexOf('/');
  return { collection: contentKey.substr(0, index), slug: contentKey.substr(index + 1) };
};

export const contentKeyFromBranch = (branch: string) => {
  return branch.substring(`${CMS_BRANCH_PREFIX}/`.length);
};

export const branchFromContentKey = (contentKey: string) => {
  return `${CMS_BRANCH_PREFIX}/${contentKey}`;
};

export interface FetchError extends Error {
  status: number;
}

interface API {
  rateLimiter?: AsyncLock;
  buildRequest: (req: ApiRequest) => ApiRequest;
  requestFunction?: (req: ApiRequest) => Promise<Response>;
}

export type ApiRequestObject = {
  url: string;
  params?: Record<string, string | boolean | number>;
  method?: 'POST' | 'PUT' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string | FormData;
  cache?: 'no-store';
};

export type ApiRequest = ApiRequestObject | string;

export const requestWithBackoff = async (
  api: API,
  req: ApiRequest,
  attempt = 1,
): Promise<Response> => {
  if (api.rateLimiter) {
    await api.rateLimiter.acquire();
  }

  try {
    const builtRequest = api.buildRequest(req);
    const requestFunction = api.requestFunction || unsentRequest.performRequest;
    const response: Response = await requestFunction(builtRequest);
    if (response.status === 429) {
      const text = await response.text().catch(() => 'Too many requests');
      throw new Error(text);
    }
    return response;
  } catch (err) {
    if (attempt <= 5) {
      if (!api.rateLimiter) {
        const timeout = attempt * attempt;
        console.log(
          `Pausing requests for ${timeout} ${
            attempt === 1 ? 'second' : 'seconds'
          } due to fetch failures:`,
          err.message,
        );

        api.rateLimiter = asyncLock();
        api.rateLimiter.acquire();
        setTimeout(() => {
          api.rateLimiter?.release();
          api.rateLimiter = undefined;
          console.log(`Done pausing requests`);
        }, 1000 * timeout);
      }
      return requestWithBackoff(api, req, attempt + 1);
    } else {
      throw err;
    }
  }
};

export const readFile = async (
  id: string | null | undefined,
  fetchContent: () => Promise<string | Blob>,
  localForage: LocalForage,
  isText: boolean,
) => {
  const key = id ? (isText ? `gh.${id}` : `gh.${id}.blob`) : null;
  const cached = key ? await localForage.getItem<string | Blob>(key) : null;
  if (cached) {
    return cached;
  }

  const content = await fetchContent();
  if (key) {
    await localForage.setItem(key, content);
  }
  return content;
};

export type FileMetadata = {
  author: string;
  updatedOn: string;
};

const getFileMetadataKey = (id: string) => `gh.${id}.meta`;

export const readFileMetadata = async (
  id: string,
  fetchMetadata: () => Promise<FileMetadata>,
  localForage: LocalForage,
) => {
  const key = getFileMetadataKey(id);
  const cached = await localForage.getItem<FileMetadata>(key);
  if (cached) {
    return cached;
  } else {
    const metadata = await fetchMetadata();
    await localForage.setItem<FileMetadata>(key, metadata);
    return metadata;
  }
};

/**
 * Keywords for inferring a status that will provide a deploy preview URL.
 */
const PREVIEW_CONTEXT_KEYWORDS = ['deploy'];

/**
 * Check a given status context string to determine if it provides a link to a
 * deploy preview. Checks for an exact match against `previewContext` if given,
 * otherwise checks for inclusion of a value from `PREVIEW_CONTEXT_KEYWORDS`.
 */
export const isPreviewContext = (context: string, previewContext: string) => {
  if (previewContext) {
    return context === previewContext;
  }
  return PREVIEW_CONTEXT_KEYWORDS.some(keyword => context.includes(keyword));
};

export enum PreviewState {
  Other = 'other',
  Success = 'success',
}

/**
 * Retrieve a deploy preview URL from an array of statuses. By default, a
 * matching status is inferred via `isPreviewContext`.
 */
export const getPreviewStatus = (
  statuses: {
    context: string;
    target_url: string;
    state: PreviewState;
  }[],
  previewContext: string,
) => {
  return statuses.find(({ context }) => {
    return isPreviewContext(context, previewContext);
  });
};
