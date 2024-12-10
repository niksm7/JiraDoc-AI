import api, { route, storage } from '@forge/api';
import markdownIt from "markdown-it";
import { Queue } from '@forge/events';
import Resolver from "@forge/resolver";

const uploadQueue = new Queue({ key: 'upload-attachment-queue' });
const resolver = new Resolver();

export async function processParentIssue(issueKey) {

  const response = await api.asApp().requestJira(route`/rest/api/3/search?jql=parent=${issueKey}&fields=summary,description,comment,attachment,subtasks`, {
    headers: {
      'Accept': 'application/json'
    }
  });

  const { issues } = await response.json();
  const final_output = {}
  for (const issue of issues) {
    final_output[issue["key"]] = {
      "title": fetchTitle(issue),
      "description": fetchDescription(issue),
      "comments": fetchComments(issue),
      "attachments": fetchAttachments(issue),
      "childTasks": ""
    }

    if (issue["fields"]["subtasks"].length > 0) {
      final_output[issue["key"]]["childTasks"] = await processParentIssue(issue["key"])
    }
  };

  return final_output
}


export async function getJiraDetails(issueKey) {

  const response = await api.asApp().requestJira(route`/rest/api/3/search?jql=id=${issueKey}&fields=summary,description,comment,attachment`, {
    headers: {
      'Accept': 'application/json'
    }
  });

  const { issues } = await response.json();
  let parentIssue = issues.find(issue => issue.key === issueKey);

  if (!parentIssue) {
    parentIssue = issues.find(issue => issue.id === issueKey);
    if (!parentIssue) {
      throw new Error(`Issue with key ${issueKey} not found.`);
    }
  }

  const final_output = {}
  final_output["title"] = fetchTitle(parentIssue)
  final_output["description"] = fetchDescription(parentIssue)
  final_output["comments"] = fetchComments(parentIssue)
  final_output["attachments"] = fetchAttachments(parentIssue)
  final_output["childTasks"] = await processParentIssue(issueKey)

  return final_output
}

export function fetchTitle(jira_data) {
  return jira_data["fields"]["summary"];
}

export function fetchDescription(jira_data) {
  return jira_data["fields"]["description"]["content"];
}

export function fetchAttachments(jira_data) {
  const attachment_data = jira_data["fields"]["attachment"];
  var content_links = []
  for (let index = 0; index < attachment_data.length; index++) {
    content_links.push(attachment_data[index]["content"])
    storage.set(attachment_data[index]["id"], `${attachment_data[index]["filename"]}&divider${attachment_data[index]["mimeType"]}`)
  }
  return content_links;
}

export function fetchComments(jira_data) {
  var comments_data = []
  const all_comments = jira_data["fields"]["comment"]["comments"]
  all_comments.forEach(element => {
    comments_data.push(element["body"])
  });
  return comments_data;
}

export async function fetchDetails(payload) {
  if (!payload.issueId) {
    throw new Error(`No Issue Id provided`)
  }
  const resp = await getJiraDetails(payload.issueId)

  return resp
}

export function extractAttachmentLinks(htmlString) {
  const regex = /<(a|img)\b[^>]*?(?:href|src)="https:\/\/api\.atlassian\.com\/ex\/jira\/[^/]+\/rest\/api\/3\/attachment\/content\/([^"]+)"[^>]*?(?:>(.*?)<\/a>|\/?>)/g;
  let match;
  const attachmentMap = {};

  while ((match = regex.exec(htmlString)) !== null) {
    const attachmentId = match[2];
    const anchorTag = match[0];
    attachmentMap[attachmentId] = anchorTag;
  }

  return attachmentMap;

}

export async function getAttachmentMetaData(attachment_id) {

  const response = await api.asApp().requestJira(route`/rest/api/3/attachment/${attachment_id}`, {
    headers: {
      'Accept': 'application/json'
    }
  });

  return await response.json()
}

export async function getAttachmentDetails(attachment_id, mime_type) {

  const response = await api.asApp().requestJira(route`/rest/api/3/attachment/content/${attachment_id}`, {
    method: 'GET',
    headers: {
      "Accept": "application/json",
      "X-Atlassian-Token": "no-check"
    },
  });

  const file_buffer = await response.arrayBuffer()

  const file_blob = new Blob([file_buffer], { type: mime_type || 'application/octet-stream' })

  return file_blob

}

resolver.define("processUploadAttachment", async ({ payload, context }) => {

  const { attachment_id, attachment_anchor, page_id, page_title, html_string, verification } = payload;

  if (verification) {
    let count = 0
    const jobProgress = uploadQueue.getJob(context.jobId);
    let response = await jobProgress.getStats();
    let { success, inProgress, failed } = await response.json();

    while (inProgress > 1 && count < 5) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      response = await jobProgress.getStats();
      inProgress = await response.json()["inProgress"];
      count += 1
    }
    let attach_filename_map = {}
    let fileMeta;
    for (const [attach_id, anchor_tag] of Object.entries(attachment_anchor)) {
      fileMeta = await storage.get(attach_id)
      fileMeta = await fileMeta.split("&divider");
      attach_filename_map[attach_id] = [anchor_tag, fileMeta[0]]
      storage.delete(attach_id)
    }
    updateConfluencePage(html_string, page_id, page_title, attach_filename_map)

    return;
  }

  try {
    // Fetch metadata and details for the attachment
    let fileMeta, filename, filemime;
    try {
      fileMeta = await storage.get(attachment_id)
      fileMeta = await fileMeta.split("&divider");
      filename = await fileMeta[0]
      filemime = await fileMeta[1]
    } catch (e) {
      console.log("Inside catch: " + e)
      fileMeta = await getAttachmentMetaData(attachment_id)
      filename = await fileMeta["filename"]
      filemime = await fileMeta["mimeType"]
      storage.set(attachment_id,`${await filename}&divider${await filemime}`)
    }
    const fileBlob = await getAttachmentDetails(attachment_id, filemime);

    // Upload the attachment
    await uploadSingleAttachment(page_id, filename, fileBlob, filemime);
  } catch (error) {
    console.error(`Failed to upload attachment ${attachment_id}: ${error}`);
  }
});


export const handler = resolver.getDefinitions();

export async function uploadSingleAttachment(page_id, filename, file_blob, mimeType) {

  const boundary = `----WebKitFormBoundary${Math.random().toString(36).substring(2, 15)}`;
  let body = `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`;
  body += `Content-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`;

  const fileArrayBuffer = await file_blob.arrayBuffer();
  const fileData = new Uint8Array(fileArrayBuffer);

  body = Buffer.concat([
    Buffer.from(body, 'utf8'),
    Buffer.from(fileData),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);

  const response = await api.asApp().requestConfluence(route`/wiki/rest/api/content/${page_id}/child/attachment`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'X-Atlassian-Token': 'nocheck',
    },
    body
  });
  if (!response.ok) throw new Error(`Attachment upload failed: ${response.status}`);
}

export async function updateConfluencePage(body_content, page_id, title, attach_filename_map) {

  for (const [_, attach_meta] of Object.entries(attach_filename_map)) {
    body_content = body_content.replace(attach_meta[0], `<ac:image><ri:attachment ri:filename="${attach_meta[1]}" /></ac:image>`)
  }

  const bodyData = JSON.stringify({
    "id": page_id,
    "status": "current",
    "title": title,
    "body": {
      "representation": "storage",
      "value": body_content
    },
    "version": {
      "number": 2,
      "message": "Initial Creation"
    }
  })

  const response = await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${page_id}`, {
    method: 'PUT',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: bodyData
  });

  let data = await response.json()
}

export async function createConfluencePage(payload) {

  if (!payload.pageBody || !payload.pageTitle || !payload.confluenceSpaceKey) {
    throw new Error(`Required Input not provided, please provide pageBody, pageTitle and confluenceSpaceKey`);
  }

  const md = markdownIt('commonmark', { breaks: true, html: true });
  const bodyHtml = md.render(payload.pageBody);

  const spaceResponse = await api.asUser().requestConfluence(route`/wiki/rest/api/space/${payload.confluenceSpaceKey}`, {
    headers: { 'Accept': 'application/json' }
  });
  const spaceId = (await spaceResponse.json())["id"];
  const pageTitle = payload.pageTitle + " (" + (Math.floor(Math.random() * (100 - 3 + 1)) + 3).toString() + ")"
  const createPageResponse = await api.asUser().requestConfluence(route`/wiki/api/v2/pages`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      spaceId,
      title: pageTitle,
      status: "current",
      body: { representation: "storage", value: "Your page is being updated, please refresh to see the updated content..." }
    })
  });
  const createdPage = await createPageResponse.json();
  const pageId = createdPage["id"];

  const attachmentIdAnchorMap = extractAttachmentLinks(bodyHtml);

  // Push events to the upload queue
  let eventsList = []
  for (const [attachmentId, attachmentAnchor] of Object.entries(attachmentIdAnchorMap)) {
    eventsList.push({
      attachment_id: attachmentId,
      attachment_anchor: attachmentAnchor,
      page_id: pageId,
      page_title: "",
      html_string: "",
      verification: false
    });
  }

  // Additional job to check verification
  eventsList.push({
    attachment_id: "",
    attachment_anchor: attachmentIdAnchorMap,
    page_id: pageId,
    page_title: pageTitle,
    html_string: bodyHtml,
    verification: true
  });

  await uploadQueue.push(eventsList)

  return createdPage["_links"]["base"] + createdPage["_links"]["webui"]
}

export async function getConfAppLinkId(payload) {
  const app_id = await storage.get("confluence-application-id")
  if (!app_id) {
    throw new Error(`Confluence application Id not set. Please provide one`);
  }
  else {
    return app_id
  }
}

export async function linkConfluenceToJira(payload) {

  storage.set("confluence-application-id", payload.confluenceApplicationId)

  const pageId = payload.confluenceLink.match(/\/pages\/(\d+)\//)

  if (!pageId) {
    throw new Error(`Page Id not present in the confluence link provided`);
  }

  const body = JSON.stringify({
    "globalId": `appId=${payload.confluenceApplicationId}&pageId=${pageId[1]}`,
    "application": {
      "type": "com.atlassian.confluence",
      "name": "Confluence"
    },
    "relationship": "Wiki Page",
    "object": {
      "url": payload.confluenceLink,
      "title": "Wiki Page",
    }
  })

  const response = await api.asUser().requestJira(route`/rest/api/3/issue/${payload.issueId}/remotelink`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: body
  });

  return await response.json()
}