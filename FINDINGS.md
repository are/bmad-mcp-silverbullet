# BMAD for AINE findings

In general, I am quite satisfied with the quality of the work done. I have only used Claude Code for this project,
no code was written by me whatsoever. I haven't used any MCP servers.

The only issues that I encountered are as follows:

1. due to limited documentation for SilverBullet, I had to manually guide Claude to certain gotchas that I discovered when I was writing a POC by myself.
2. I have run out of tokens at the beginning of Epic 2, so I had to revert to a working state. I severly underestimated how many tokens will BMAD consume -
   a fresh session for each step of the story consumes tremendous amount of tokens. I have hit my weekly limit quite quickly compared to a frameworkless approach.
3. due to interacting with an external system (the SilverBullet Space Lua implementation) it was difficult for Claude to understand quickly how to adjust the Lua snippets
   to work. The model never stopped to ask additional questions during the development time and it assumed/hallucinated a lot of things that were underspecified or not clear.
