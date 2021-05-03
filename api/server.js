import { ApolloServer, gql } from "apollo-server";
import { resolvers } from "./resolvers-pg.js";

const typeDefs = gql`
  type Query {
    hello: String
    users: [User]
    repos: [Repo]
    repo(name: String): Repo
    pods(repo: String): [Pod]
  }

  type AuthData {
    token: String
  }

  type User {
    id: ID!
    username: String!
    email: String!
    password: String!
    name: String
  }

  type Repo {
    id: ID!
    name: String!
    owner: User!
    root: Deck
  }

  type Pod {
    id: ID!
    content: String!
    parent: Deck
  }

  type Deck {
    id: ID!
    parent: Deck
    children: [Pod]
  }

  type Mutation {
    login(username: String, password: String): AuthData
    signup(
      username: String
      email: String
      password: String
      name: String
    ): AuthData
    createRepo(name: String): Repo
    createPod(
      reponame: String
      name: String
      content: String
      parent: String
      index: Int
    ): Pod
    clearUser: Boolean
    clearRepo: Boolean
    clearPod: Boolean
  }
`;

const server = new ApolloServer({
  typeDefs,
  resolvers,
});

server.listen().then(() => {
  console.log(`
      Server is running!
      Listening on port 4000
      Explore at https://studio.apollographql.com/dev
      Explore at http://localhost:4000/graphql
    `);
});
