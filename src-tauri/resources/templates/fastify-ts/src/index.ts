import Fastify from "fastify";

const fastify = Fastify({ logger: true });

fastify.get("/", async () => {
  return { message: "Hello World" };
});

const start = async () => {
  try {
    await fastify.listen({ port: Number(process.env.PORT) || 7777, host: "0.0.0.0" });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
