
<template>
	<div
		class="main-menu container mx-auto font-bold md:flex justify-center md:justify-between items-center py-3 md:py-10"
	>
		<router-link class="hidden text-center md:inline text-3xl" :to="'/'">Mauritius Reservoirs</router-link>

		<ul class="flex mr-3">
			<li>
				<a href="#" target="_blank">View other projects →</a>
				<!-- <SvgMenuBg /> -->
			</li>
		</ul>
	</div>
</template>

<style scoped>
.main-menu ul {
	list-style: none;
	display: flex;
	justify-content: center;
}

.main-menu ul li {
	position: relative;
}

.main-menu ul li button {
	margin: 10px;
}

.main-menu ul li a {
	padding: 10px;
	display: block;
	border-width: 2px;
	text-decoration: none;
	border-color: transparent;
	cursor: pointer;
}

@media (min-width: 640px) {
	.main-menu ul li {
		padding: 10px;
	}
}
</style>
