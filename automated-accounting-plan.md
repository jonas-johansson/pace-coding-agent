Interview me relentlessly about every aspect of this plan until
we reach a shared understanding. Walk down each branch of the design
tree resolving dependencies between decisions one by one.

If a question can be answered by exploring the codebase, explore
the codebase instead.

For each question, provide your recommended answer.

# Automated Accounting Procedure

I'm working on this coding agent and I want to be able to use it to automate my accounting procedure - finding receipts and invoices in my email and reporting them as receipts to my accounting service Wint.

## Current manual procedure

- I log in to Gmail and go through all the emails in my inbox (not archived emails)
- For each email that looks like a receipt or invoice and has PDF attachments:
  - Download the receipt or invoice PDFs
  - Open the PDFs and extract metadata: date, currency, amount, vat, category, description
  - I log in to Wint and create a receipt with the metadata and PDFs
  - Archive the email

## External services involved

Gmail
- Auth with OAuth
- Functions to search email and download attachments

Wint (accounting service)
- Auth with Basic Auth: `Authorization: Basic <base64(accountId:apiKey)>`
- Functions to create a receipt with metadata and PDFs

## Security

It's important to keep raw credentials away from the agent since it could be prompt injected to leak credentials.

Some functions need to have human in the loop, ex: create Wint receipt, archive email, but searching the email is fine, and so is downloading attachments.

## Context pollution

We want to avoid letting the PDF file data pass through the LLMs context since it's just intermediate data that isn't relevant to the LLM itself.